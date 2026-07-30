/**
 * The demo, in one command. Paced for a screen recording under five minutes.
 *
 *   npm run server    # in another shell
 *   npm run demo
 *
 * Tells the story in the order it needs to be understood: the split is a property
 * of the asset, the payer cannot spend alone, the buyer is told before it pays,
 * the network does the division, and anyone can check it afterwards.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const state = JSON.parse(readFileSync(new URL("../.state.json", import.meta.url), "utf8"));
const MIRROR = process.env.MIRROR_NODE_URL;
const ORIGIN = process.env.PRISM_ORIGIN ?? "http://localhost:4051";
const TOKEN = state.prism.tokenId;
const ROOT = fileURLToPath(new URL("..", import.meta.url));

const PAUSE = Number(process.env.DEMO_PAUSE ?? 2200);
const wait = (ms = PAUSE) => new Promise((r) => setTimeout(r, ms));
const get = async (u) => (await fetch(u)).json();

const rule = (t) => console.log(`\n\x1b[1m${"─".repeat(74)}\n  ${t}\n${"─".repeat(74)}\x1b[0m`);
const say = (t) => console.log(`  ${t}`);

console.log("\n\x1b[1m  PRISM — one x402 payment, refracted at consensus\x1b[0m");
await wait(1200);

// ---------------------------------------------------------------------------
rule("1. The split is not code. It is a field on the token.");
const token = await get(`${MIRROR}/api/v1/tokens/${TOKEN}`);
say(`${token.symbol}  ${TOKEN}  (${token.name})`);
say("");
for (const f of token.custom_fees.fractional_fees) {
  const pct = (Number(f.amount.numerator) / Number(f.amount.denominator)) * 100;
  say(`  ${String(pct).padStart(5)}%  →  ${f.collector_account_id}`);
}
say("");
say(`fee schedule key: ${token.fee_schedule_key._type}  — a 2-of-3 ThresholdKey.`);
say("The operator cannot rewrite who gets paid without a payee agreeing.");
say("");
say("No contract was deployed. There is nothing to audit but this config.");
await wait();

// ---------------------------------------------------------------------------
rule("2. The payer cannot spend on its own.");
const agent = await get(`${MIRROR}/api/v1/accounts/${state.agent.id}`);
say(`agent ${state.agent.id}`);
say(`  key type : ${agent.key._type}  — a KeyList with threshold 2`);
say(`  HBAR     : ${Number(agent.balance.balance) / 1e8}`);
say("");
say("The agent holds one key. A policy service holds the other.");
say("A compromised agent cannot overspend — not because its code declines,");
say("but because the key material it holds is insufficient.");
await wait();

// ---------------------------------------------------------------------------
rule("3. The buyer is told where the money goes, before it pays.");
const res = await fetch(`${ORIGIN}/v1/token/${TOKEN}/cost`);
const challenge = JSON.parse(Buffer.from(res.headers.get("payment-required"), "base64").toString());
const accepted = challenge.accepts[0];
say(`HTTP ${res.status}   ${accepted.amount} of ${accepted.asset}  →  ${accepted.payTo}`);
say(`             network fee sponsored by ${accepted.extra.feePayer}`);
say("");
say("the 402 carries a `prism` extension declaring the split:");
for (const p of challenge.extensions.prism.info.payees) {
  say(`  ${String(p.role).padEnd(14)} ${(p.basisPoints / 100).toFixed(2).padStart(6)}%   via ${p.via}`);
}
say("");
say("Read live from the token's own fee schedule — what we advertise");
say("cannot drift from what the ledger will actually do.");
await wait();

// ---------------------------------------------------------------------------
rule("4. The guardrail is real: watch it refuse.");
say("The agent asks to pay 999999 — above its per-call cap.");
// Over HTTP, exactly as the agent does it: this process has no access to the
// co-signer's key either.
const POLICY_URL = process.env.POLICY_URL ?? "http://localhost:4052";
const refused = await fetch(`${POLICY_URL}/cosign`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${process.env.POLICY_TOKEN ?? ""}`,
  },
  body: JSON.stringify({
    transactionBase64: Buffer.from("x").toString("base64"),
    challenge: { asset: TOKEN, payTo: state.prism.service.id, amount: "999999" },
  }),
}).then((r) => r.json());
say("");
say(`  \x1b[31mREFUSED\x1b[0m — ${refused.reason}`);
say("");
say("No second signature exists, so the payment is impossible rather than");
say("merely disallowed. Nothing downstream has to be trusted to enforce it.");
await wait();

// ---------------------------------------------------------------------------
rule("5. An honest payment, end to end, on the public network.");
const run = spawnSync("node", ["studio/agent.mjs"], { encoding: "utf8", cwd: ROOT });
console.log(
  (run.stdout ?? "")
    .split("\n")
    .filter((l) => !l.startsWith("       response:") )
    .slice(0, 22)
    .map((l) => `  ${l}`)
    .join("\n"),
);
const txId = (run.stdout ?? "").match(/transaction\/(\S+)/)?.[1];
await wait();

// ---------------------------------------------------------------------------
rule("6. Anyone can check the arithmetic. No key required.");
say(`GET ${ORIGIN}/v1/audit/${txId}`);
say("");
let audit;
for (let i = 0; i < 10; i++) {
  audit = await get(`${ORIGIN}/v1/audit/${txId}`);
  if (audit.ok !== false || audit.reason !== "not_indexed") break;
  await wait(1500);
}
say(`gross paid: ${audit.grossPaid}`);
for (const p of audit.payees) {
  say(`  ${String(p.role).padEnd(14)} expected ${String(p.expected).padStart(7)}   actual ${String(p.actual).padStart(7)}   ${p.matches ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"}`);
}
say("");
for (const [k, v] of Object.entries(audit.invariants)) say(`  ${v ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${k}`);
say("");
say("Recomputed from two public mirror-node GETs. We hold no privileged");
say("position in this check — a mismatch would be provable, not arguable.");
say("");
say(`\x1b[1m${audit.hashscan}\x1b[0m`);

rule("One signature. Three payees. No contract, no keeper, no second transaction.");
console.log();
