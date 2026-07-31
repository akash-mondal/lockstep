/**
 * Lockstep agent client — the buyer's side of the flow.
 *
 * Drives a real 402 → sign → retry → settle cycle against the resource server,
 * paying from a Hedera ThresholdKey account. The agent holds one key; the policy
 * co-signer holds the other. Neither can move funds alone, and that constraint is
 * enforced by the ledger rather than by this code.
 *
 * Everything settles in native HBAR. The agent pays no network fee: the
 * facilitator is the transaction's fee payer, so the account needs only what it
 * intends to spend.
 *
 *   npm run agent                       pay the cost route
 *   npm run agent -- --route risk       pay the risk route
 *   npm run agent -- --amount 500000000 ask a bigger question
 */
import { readFileSync } from "node:fs";
import "dotenv/config";
import {
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  TokenId,
  TransactionId,
  TransferTransaction,
} from "@hiero-ledger/sdk";
const POLICY_URL = process.env.POLICY_URL ?? "http://localhost:4052";

/**
 * Ask the policy service to add the second signature.
 *
 * Deliberately an HTTP call and not an import: this process must have no way to
 * reach the co-signer's key. If the agent could load it, the threshold account
 * would look right on-chain while protecting nothing.
 */
async function requestCosign(payload) {
  let res;
  try {
    res = await fetch(`${POLICY_URL}/cosign`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.POLICY_TOKEN ?? ""}`,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error(`policy co-signer unreachable at ${POLICY_URL} — start it with \`npm run policy\``);
  }
  return res.json();
}

const state = JSON.parse(readFileSync(new URL("../.state.json", import.meta.url), "utf8"));
const ORIGIN = process.env.LOCKSTEP_ORIGIN ?? "http://localhost:4051";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const route = flag("route", "cost");
const target =
  route === "risk"
    ? `${ORIGIN}/v1/account/${flag("id", state.lockstep.service.id)}/risk?asset=0.0.0`
    : `${ORIGIN}/v1/token/${flag("id", process.env.USDC_TOKEN_ID ?? "0.0.429274")}/cost?amount=${flag("amount", "1000000")}`;

const agentId = state.agent.id;
const agentKey = PrivateKey.fromStringECDSA(state.agent.agentKey);
const client = Client.forTestnet().setOperator(
  AccountId.fromString(process.env.OPERATOR_ID),
  PrivateKey.fromStringECDSA(process.env.OPERATOR_KEY),
);

const decode = (b64) => JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64");

try {
  // Report the real balance rather than asserting a number. The agent pays no
  // network fee, but it does fund the payment itself, so what it holds should be
  // visible rather than claimed.
  const bal = await (await fetch(`${process.env.MIRROR_NODE_URL}/api/v1/accounts/${agentId}`)).json();
  const tinybars = Number(bal.balance?.balance ?? 0);
  console.log(`agent  ${agentId}  (ThresholdKey 2-of-2, holds ${tinybars / 1e8} HBAR)`);
  console.log(`GET    ${target}\n`);

  // ---- 1. Trigger the challenge -------------------------------------------
  const first = await fetch(target);
  if (first.status !== 402) {
    console.log(`Expected 402, got ${first.status}: ${await first.text()}`);
    process.exit(1);
  }
  const challenge = decode(first.headers.get("payment-required"));
  const accepted = challenge.accepts[0];
  console.log(`402    ${accepted.amount} of ${accepted.asset} → ${accepted.payTo}`);
  console.log(`       feePayer ${accepted.extra.feePayer} (sponsors the network fee)`);

  const disclosure = challenge.extensions?.lockstep?.info;
  if (disclosure) {
    console.log(`\n       the 402 discloses where the money goes:`);
    for (const p of disclosure.payees) {
      console.log(`         ${String(p.role).padEnd(14)} ${(p.basisPoints / 100).toFixed(2).padStart(6)}%  via ${p.via}`);
    }
  } else {
    console.log(`\n       (no lockstep extension — this route settles to a single payee)`);
  }

  // ---- 2. Build the payment exactly as the exact scheme requires -----------
  const amount = BigInt(accepted.amount);
  const tx = new TransferTransaction();
  if (accepted.asset === "0.0.0") {
    tx.addHbarTransfer(AccountId.fromString(agentId), Hbar.fromTinybars(-amount))
      .addHbarTransfer(AccountId.fromString(accepted.payTo), Hbar.fromTinybars(amount));
  } else {
    const token = TokenId.fromString(accepted.asset);
    tx.addTokenTransfer(token, AccountId.fromString(agentId), -amount)
      .addTokenTransfer(token, AccountId.fromString(accepted.payTo), amount);
  }
  // Naming the facilitator as the transaction's payer is what makes it sponsor fees.
  tx.setTransactionId(TransactionId.generate(AccountId.fromString(accepted.extra.feePayer)));
  tx.freezeWith(client);

  // ---- 3. Agent signs, then asks the policy service to co-sign ------------
  const agentSigned = await tx.sign(agentKey);
  console.log(`\n       agent signed — 1 of 2 signatures, not yet spendable`);

  const decision = await requestCosign({
    transactionBase64: Buffer.from(agentSigned.toBytes()).toString("base64"),
    challenge: accepted,
    resource: challenge.resource,
  });
  if (!decision.approved) {
    console.log(`\n  POLICY REFUSED: ${decision.reason}`);
    console.log(`  The agent cannot proceed. It does not hold a second key, so the`);
    console.log(`  payment is impossible — not merely disallowed by convention.`);
    process.exit(2);
  }
  console.log(`       policy co-signed — ${decision.reason}`);

  // ---- 4. Retry with the payment ------------------------------------------
  const paid = await fetch(target, {
    headers: {
      "payment-signature": encode({
        x402Version: 2,
        resource: challenge.resource,
        accepted,
        payload: { transaction: decision.transactionBase64 },
      }),
    },
  });

  console.log(`\n${paid.status}    ${paid.status === 200 ? "paid and served" : "failed"}`);
  const settle = paid.headers.get("payment-response");
  if (settle) {
    const s = decode(settle);
    console.log(`       tx ${s.transaction}  payer ${s.payer}`);
    const lockstep = s.extensions?.lockstep;
    if (lockstep) {
      console.log(`\n       what the network actually assessed:`);
      for (const r of lockstep.refracted ?? []) {
        console.log(`         ${String(r.role).padEnd(14)} ${r.amount}`);
      }
      if (!lockstep.refracted?.length && !lockstep.indexed) {
        console.log(`         (mirror node has not indexed it yet — check ${lockstep.audit})`);
      }
      console.log(`\n       ${lockstep.hashscan}`);
      console.log(`       audit (keyless): ${ORIGIN}${lockstep.audit}`);
    }
  }

  const body = await paid.json();
  console.log(`\n       response:`);
  console.log(
    JSON.stringify(body, null, 2)
      .split("\n")
      .slice(0, 24)
      .map((l) => `         ${l}`)
      .join("\n"),
  );
} catch (err) {
  console.error(`\nclient error: ${err?.message ?? err}`);
  process.exitCode = 1;
} finally {
  client.close();
}
