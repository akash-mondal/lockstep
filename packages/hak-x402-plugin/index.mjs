/**
 * hak-x402-plugin — x402 tools for the Hedera Agent Kit.
 *
 * The Agent Kit ships ten core plugins (account, consensus, token, EVM and their
 * query variants) and none of them speak x402: `@hashgraph/hedera-agent-kit@4.0.0`
 * contains no x402 code at all. So an agent built on the Kit can transfer HBAR and
 * mint tokens, but cannot pay for an HTTP resource — which is the one thing the
 * agent economy actually needs.
 *
 * This plugin closes that gap using the v4 BaseTool pattern, so the tools take
 * part in the Kit's hooks and policies lifecycle (spend limits, allowlists, audit
 * trails) rather than bypassing it.
 *
 * Three tools, only one of which needs a key:
 *
 *   x402_inspect_challenge   read a 402 without paying — price, asset, fee payer,
 *                            and any disclosed revenue split
 *   x402_pay_resource        the full 402 → sign → retry → settle cycle
 *   x402_audit_settlement    recompute a settlement from public mirror-node data;
 *                            needs no key and no cooperation from the seller
 */
import { z } from "zod";
import { BaseTool } from "@hashgraph/hedera-agent-kit";
import {
  AccountId,
  Hbar,
  PrivateKey,
  TokenId,
  Transaction,
  TransactionId,
  TransferTransaction,
} from "@hiero-ledger/sdk";

const decode = (b64) => JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64");
const MIRROR = "https://testnet.mirrornode.hedera.com";

/** Read the 402 challenge off a response, tolerating header-name casing. */
function readChallenge(res) {
  const raw = res.headers.get("payment-required") ?? res.headers.get("PAYMENT-REQUIRED");
  if (!raw) throw new Error("no PAYMENT-REQUIRED header on the 402 response");
  return decode(raw);
}

function summarizeSplit(challenge) {
  const info = challenge.extensions?.lockstep?.info;
  if (!info) return null;
  return {
    mechanism: info.mechanism,
    settlement: info.settlement,
    payerDebit: info.payerDebit,
    payees: info.payees,
  };
}

export class X402InspectChallengeTool extends BaseTool {
  method = "x402_inspect_challenge";
  name = "Inspect x402 Payment Challenge";
  description = `
Fetch an x402-protected URL without paying and report what it would cost.

Parameters:
- url (str, required): the resource URL to probe

Returns the price, asset, recipient, sponsoring fee payer, and — if the server
discloses one — the revenue split that the payment would be divided into.
Use this before paying anything, to check the terms.
`;
  parameters = z.object({ url: z.string().url() });
  outputParser = undefined;

  async normalizeParams(params) {
    return params;
  }
  shouldSecondaryAction() {
    return false;
  }
  async secondaryAction() {}

  async coreAction({ url }) {
    const res = await fetch(url);
    if (res.status !== 402) {
      return { paid: false, status: res.status, note: "resource did not ask for payment" };
    }
    const challenge = readChallenge(res);
    const accepted = challenge.accepts?.[0] ?? {};
    return {
      url,
      price: { amount: accepted.amount, asset: accepted.asset, network: accepted.network },
      payTo: accepted.payTo,
      feePayer: accepted.extra?.feePayer,
      // Sponsored fees are why a payer can hold no HBAR at all.
      payerNeedsHbar: accepted.asset === "0.0.0",
      disclosedSplit: summarizeSplit(challenge),
      resource: challenge.resource,
    };
  }
}

export class X402PayResourceTool extends BaseTool {
  method = "x402_pay_resource";
  name = "Pay for an x402 Resource";
  description = `
Pay for an x402-protected HTTP resource on Hedera and return its content.

Parameters:
- url (str, required): the resource URL
- maxAmount (str, optional): refuse to pay more than this, in the asset's smallest unit

Performs the full cycle: request, read the 402, build and sign a Hedera transfer,
retry with the payment, and return the response plus the settled transaction id.
Network fees are paid by the facilitator, so the paying account needs no HBAR
unless the resource is priced in HBAR itself.
`;
  parameters = z.object({
    url: z.string().url(),
    maxAmount: z.string().optional(),
  });
  outputParser = undefined;

  async normalizeParams(params) {
    return params;
  }

  /**
   * Only submit when the core action actually prepared a payment.
   *
   * The split between the two stages is deliberate. `coreAction` reads the 402 and
   * *builds* the transfer without signing it; `postCoreActionHook` then runs, which
   * is where the Kit's policies (spend limits, allowlists, audit trails) get to
   * inspect a concrete payment before anything reaches the network. Doing the whole
   * payment inside `coreAction` would settle on-chain before any policy had seen it.
   */
  shouldSecondaryAction(coreActionResult) {
    return Boolean(coreActionResult?.prepared);
  }

  /** Stage 5: sign the prepared transfer and retry the request with it. */
  async secondaryAction(prepared, client, context) {
    const { url, challenge, accepted, transactionBytes } = prepared;
    let tx = Transaction.fromBytes(Buffer.from(transactionBytes, "base64"));

    const explicit = context?.privateKey;
    tx = explicit
      ? await tx.sign(typeof explicit === "string" ? PrivateKey.fromStringECDSA(explicit) : explicit)
      : await tx.signWithOperator(client);

    const paid = await fetch(url, {
      headers: {
        "payment-signature": encode({
          x402Version: 2,
          resource: challenge.resource,
          accepted,
          payload: { transaction: Buffer.from(tx.toBytes()).toString("base64") },
        }),
      },
    });

    const settleHeader = paid.headers.get("payment-response");
    const settle = settleHeader ? decode(settleHeader) : null;
    return {
      paid: paid.status === 200,
      status: paid.status,
      amountPaid: prepared.amount,
      asset: accepted.asset,
      transaction: settle?.transaction,
      refracted: settle?.extensions?.lockstep?.refracted ?? null,
      hashscan: settle?.extensions?.lockstep?.hashscan ?? null,
      body: await paid.json().catch(() => null),
    };
  }

  /** Stage 4: read the challenge and build — but do not sign — the payment. */
  async coreAction({ url, maxAmount }, context, client) {
    const res = await fetch(url);
    if (res.status !== 402) return { paid: false, status: res.status, body: await res.text() };

    const challenge = readChallenge(res);
    const accepted = challenge.accepts?.[0];
    if (!accepted) throw new Error("402 carried no accepts[] entry");
    if (!String(accepted.network).startsWith("hedera:")) {
      throw new Error(`this tool only pays on Hedera; challenge names ${accepted.network}`);
    }

    const amount = BigInt(accepted.amount);
    // A ceiling the agent controls, checked before anything is signed.
    if (maxAmount && amount > BigInt(maxAmount)) {
      return { paid: false, refused: `price ${amount} exceeds maxAmount ${maxAmount}` };
    }

    const payer = context?.accountId ?? client.operatorAccountId?.toString();
    if (!payer) throw new Error("no paying account configured on the agent context");

    const tx = new TransferTransaction();
    if (accepted.asset === "0.0.0") {
      tx.addHbarTransfer(AccountId.fromString(payer), Hbar.fromTinybars(-amount))
        .addHbarTransfer(AccountId.fromString(accepted.payTo), Hbar.fromTinybars(amount));
    } else {
      const token = TokenId.fromString(accepted.asset);
      tx.addTokenTransfer(token, AccountId.fromString(payer), -amount)
        .addTokenTransfer(token, AccountId.fromString(accepted.payTo), amount);
    }
    // Naming the facilitator as transaction payer is what makes it sponsor the fee.
    tx.setTransactionId(TransactionId.generate(AccountId.fromString(accepted.extra.feePayer)));
    tx.freezeWith(client);

    // Frozen but unsigned. Nothing has touched the network yet, so a policy hook
    // reading this result can still stop the payment.
    return {
      prepared: true,
      url,
      challenge,
      accepted,
      payer,
      payTo: accepted.payTo,
      asset: accepted.asset,
      amount: String(amount),
      disclosedSplit: summarizeSplit(challenge),
      transactionBytes: Buffer.from(tx.toBytes()).toString("base64"),
    };
  }
}

export class X402AuditSettlementTool extends BaseTool {
  method = "x402_audit_settlement";
  name = "Audit an x402 Settlement";
  description = `
Independently verify what a Hedera x402 payment actually moved, using only public
mirror-node data. Needs no key and no cooperation from the seller.

Parameters:
- transactionId (str, required): mirror-node form, e.g. 0.0.1234-1700000000-000000000

Reports every account credited, any custom fees the network assessed, and whether
the transfers sum to zero. Use this to check that a seller's disclosed revenue
split matches what the ledger did.
`;
  parameters = z.object({ transactionId: z.string() });
  outputParser = undefined;

  async normalizeParams(params) {
    return params;
  }
  shouldSecondaryAction() {
    return false;
  }
  async secondaryAction() {}

  async coreAction({ transactionId }) {
    const res = await fetch(`${MIRROR}/api/v1/transactions/${transactionId}`);
    if (!res.ok) return { found: false, transactionId, note: `mirror node returned ${res.status}` };
    const record = (await res.json()).transactions?.[0];
    if (!record) return { found: false, transactionId, note: "not indexed yet" };

    const transfers = record.token_transfers ?? [];
    const assessed = record.assessed_custom_fees ?? [];
    const sum = transfers.reduce((s, t) => s + BigInt(t.amount), 0n);
    return {
      found: true,
      transactionId,
      consensusTimestamp: record.consensus_timestamp,
      result: record.result,
      credits: transfers.filter((t) => BigInt(t.amount) > 0n).map((t) => ({ account: t.account, amount: String(t.amount), token: t.token_id })),
      debits: transfers.filter((t) => BigInt(t.amount) < 0n).map((t) => ({ account: t.account, amount: String(t.amount), token: t.token_id })),
      assessedCustomFees: assessed.map((f) => ({
        collector: f.collector_account_id,
        amount: String(f.amount),
        token: f.token_id,
        effectivePayers: f.effective_payer_account_ids,
      })),
      transfersSumToZero: sum === 0n,
      hashscan: `https://hashscan.io/testnet/transaction/${transactionId}`,
    };
  }
}

/** Plugin descriptor in the shape the Agent Kit expects. */
export const x402Plugin = {
  name: "x402-plugin",
  version: "0.1.0",
  description: "Pay for, inspect, and audit x402 HTTP resources on Hedera.",
  tools: () => [
    new X402InspectChallengeTool(),
    new X402PayResourceTool(),
    new X402AuditSettlementTool(),
  ],
};

export default x402Plugin;
