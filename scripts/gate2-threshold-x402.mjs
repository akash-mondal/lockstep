/**
 * GATE 2 — can a ThresholdKey account be an x402 payer, and does a fee-bearing
 * token survive a real facilitator's verification?
 *
 * Two unproven claims in one transaction:
 *
 *   a) The payer is a KeyList(threshold 2) account — the agent holds one key, a
 *      policy co-signer holds the other. @x402/hedera's `keySignsTransaction`
 *      recurses through KeyLists and counts signatures against the threshold, so
 *      this should work; nobody appears to have exercised it.
 *
 *   b) The asset carries a fractional custom fee. Rule 5 of the exact scheme says
 *      "no additional positive net transfers to any other party besides payTo" —
 *      but that reads the *signed body*, and custom fees are merged in at
 *      consensus. If the facilitator accepts this, Lockstep is spec-compliant rather
 *      than merely clever.
 *
 * Runs against both public facilitators independently: shared reference code
 * doesn't guarantee shared policy, and the spec lets implementations be stricter.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import "dotenv/config";
import { requireOperator, requireState } from "./_prereq.mjs";
import {
  AccountCreateTransaction,
  AccountId,
  Client,
  Hbar,
  KeyList,
  PrivateKey,
  TokenId,
  TransactionId,
  TransferTransaction,
} from "@hiero-ledger/sdk";

const { MIRROR_NODE_URL } = process.env;
const { OPERATOR_ID, OPERATOR_KEY } = requireOperator();
const STATE_PATH = new URL("../.state.json", import.meta.url);
const POLICY_KEY_PATH = new URL("../.policy.key", import.meta.url);
const state = requireState([
  ["tokenId", "Gate 1", "npm run gate1"],
  ["seller.id", "Gate 1", "npm run gate1"],
  ["collector.id", "Gate 1", "npm run gate1"],
]);

const FACILITATORS = {
  "x402.org": "https://x402.org/facilitator",
  blocky402: "https://api.testnet.blocky402.com",
};
const DECIMALS = 6;
const UNIT = 10 ** DECIMALS;
const PAYMENT = 10 * UNIT; // 10 tokens; a 1/10 fee should route 1 to the collector
const SEED = 500 * UNIT;

const operatorKey = PrivateKey.fromStringECDSA(OPERATOR_KEY);
const client = Client.forTestnet().setOperator(AccountId.fromString(OPERATOR_ID), operatorKey);
const tokenId = state.tokenId;
const step = (n, m) => console.log(`\n[${n}] ${m}`);

const toMirrorTxId = (id) => id.toString().replace("@", "-").replace(/\.(\d+)$/, "-$1");

async function fetchRecord(mirrorId, attempts = 15) {
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(`${MIRROR_NODE_URL}/api/v1/transactions/${mirrorId}`);
    if (res.ok) {
      const b = await res.json();
      if (b.transactions?.length) return b.transactions[0];
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`no mirror record for ${mirrorId}`);
}

/** Read the fee payer this facilitator wants us to name — never hardcode it. */
async function feePayerFor(url) {
  const res = await fetch(`${url}/supported`);
  const body = await res.json();
  const kinds = body.kinds ?? body;
  const hedera = kinds.find((k) => k.network === "hedera:testnet" && k.scheme === "exact");
  return hedera?.extra?.feePayer ?? null;
}

try {
  step(1, "Creating the threshold-key agent account (2-of-2: agent key + policy key)");
  let agentId, agentKey, policyKey;
  if (state.agent?.id) {
    ({ id: agentId } = state.agent);
    agentKey = PrivateKey.fromStringECDSA(state.agent.agentKey);
    // Read the co-signer half from its own file, the same place the policy
    // service reads it. This gate is operator tooling, so it legitimately needs
    // both; the agent process never does.
    policyKey = PrivateKey.fromStringECDSA(readFileSync(POLICY_KEY_PATH, "utf8").trim());
    console.log(`    agent     ${agentId}  (reused)`);
  } else {
    agentKey = PrivateKey.generateECDSA();
    policyKey = PrivateKey.generateECDSA();
    const thresholdKey = new KeyList([agentKey.publicKey, policyKey.publicKey], 2);
    const receipt = await new AccountCreateTransaction()
      .setKeyWithoutAlias(thresholdKey)
      .setInitialBalance(new Hbar(0)) // the agent never holds HBAR — the facilitator sponsors fees
      .setMaxAutomaticTokenAssociations(-1)
      .execute(client)
      .then((r) => r.getReceipt(client));
    agentId = receipt.accountId.toString();
    // The two halves are stored apart on purpose. `.state.json` is what the agent
    // loads; the co-signer's key goes to its own 0600 file that only the policy
    // service reads. Writing both here would give the account the right shape
    // on-chain while the compromise boundary it implies did not exist.
    state.agent = { id: agentId, agentKey: agentKey.toStringRaw() };
    writeFileSync(POLICY_KEY_PATH, `${policyKey.toStringRaw()}\n`, { mode: 0o600 });
    console.log(`    agent     ${agentId}  (0 HBAR, KeyList threshold 2 of 2)`);
    console.log(`    co-signer key written to .policy.key (0600) — not in .state.json`);
  }

  // Confirm the network really recorded a threshold key, not a flattened single key.
  const acct = await (await fetch(`${MIRROR_NODE_URL}/api/v1/accounts/${agentId}`)).json();
  console.log(`    on-chain key type: ${acct.key?._type}`);

  step(2, `Seeding the agent with ${SEED / UNIT} ${tokenId} from the treasury`);
  await new TransferTransaction()
    .addTokenTransfer(tokenId, OPERATOR_ID, -SEED)
    .addTokenTransfer(tokenId, agentId, SEED)
    .execute(client)
    .then((r) => r.getReceipt(client));
  console.log("    seeded");

  const payTo = state.seller.id;
  const collector = state.collector.id;
  const results = {};

  for (const [name, url] of Object.entries(FACILITATORS)) {
    step(3, `Facilitator: ${name} (${url})`);
    const feePayer = await feePayerFor(url);
    if (!feePayer) {
      console.log("    no hedera:testnet exact kind advertised — skipping");
      results[name] = { verify: "unsupported" };
      continue;
    }
    console.log(`    advertised feePayer: ${feePayer}`);

    // Built exactly as @x402/hedera's reference client does, then signed twice.
    const tx = new TransferTransaction()
      .addTokenTransfer(TokenId.fromString(tokenId), AccountId.fromString(agentId), -PAYMENT)
      .addTokenTransfer(TokenId.fromString(tokenId), AccountId.fromString(payTo), PAYMENT)
      .setTransactionId(TransactionId.generate(AccountId.fromString(feePayer)));
    tx.freezeWith(client);
    const signed = await (await tx.sign(agentKey)).sign(policyKey);
    const transaction = Buffer.from(signed.toBytes()).toString("base64");

    const paymentRequirements = {
      scheme: "exact",
      network: "hedera:testnet",
      amount: String(PAYMENT),
      asset: tokenId,
      payTo,
      maxTimeoutSeconds: 180,
      extra: { feePayer },
    };
    // PaymentPayloadV2 requires `accepted` — the facilitator reads scheme/network
    // off it, not off the sibling paymentRequirements.
    const paymentPayload = {
      x402Version: 2,
      resource: {
        url: "https://lockstep.local/gate2",
        description: "Gate 2 probe",
        mimeType: "application/json",
      },
      accepted: paymentRequirements,
      payload: { transaction },
    };
    const body = JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements });

    const verifyRes = await fetch(`${url}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const verify = await verifyRes.json().catch(() => ({ parseError: true }));
    console.log(`    /verify  HTTP ${verifyRes.status}  ${JSON.stringify(verify)}`);
    results[name] = { verify };

    if (!verify.isValid) continue;

    const settleRes = await fetch(`${url}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const settle = await settleRes.json().catch(() => ({ parseError: true }));
    console.log(`    /settle  HTTP ${settleRes.status}  ${JSON.stringify(settle)}`);
    results[name].settle = settle;

    if (settle.success && settle.transaction) {
      const mirrorId = toMirrorTxId(settle.transaction);
      const record = await fetchRecord(mirrorId);
      const assessed = record.assessed_custom_fees ?? [];
      const transfers = (record.token_transfers ?? []).filter((t) => t.token_id === tokenId);
      console.log("\n    on-chain result:");
      for (const t of transfers) {
        const who = t.account === agentId ? "agent" : t.account === payTo ? "payTo" : t.account === collector ? "collector" : t.account;
        console.log(`      ${who.padEnd(10)} ${String(t.amount).padStart(11)}  (${t.amount / UNIT})`);
      }
      console.log(`      assessed_custom_fees: ${assessed.length ? JSON.stringify(assessed) : "(none)"}`);
      console.log(`      https://hashscan.io/testnet/transaction/${mirrorId}`);
      results[name].onchain = { mirrorId, assessed, transfers };
      state.gate2 = { ...(state.gate2 ?? {}), [name]: mirrorId };
    }
  }

  console.log("\n" + "=".repeat(70));
  let pass = true;
  for (const [name, r] of Object.entries(results)) {
    const ok = r.verify?.isValid && r.settle?.success && (r.onchain?.assessed?.length ?? 0) > 0;
    if (r.verify !== "unsupported" && !ok) pass = false;
    console.log(`  ${name.padEnd(12)} verify=${r.verify?.isValid ?? r.verify}  settle=${r.settle?.success ?? "-"}  fees=${r.onchain?.assessed?.length ?? 0}`);
  }
  console.log("=".repeat(70));
  console.log(pass ? "  GATE 2 PASSED — threshold payer + fee-bearing asset accepted" : "  GATE 2 FAILED");
  console.log("=".repeat(70));
} catch (err) {
  console.error(`\nGate 2 errored: ${err?.message ?? err}`);
  process.exitCode = 1;
} finally {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  client.close();
}
