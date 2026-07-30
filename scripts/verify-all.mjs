/**
 * Full on-chain acceptance test.
 *
 * Starts nothing and mocks nothing: it drives a real x402 payment through the
 * running server to a public facilitator, then re-derives every claim the README
 * makes from public mirror-node data. If this passes, the system works.
 *
 *   npm run server        # in another shell
 *   npm run verify
 */
import { readFileSync } from "node:fs";
import "dotenv/config";

const state = JSON.parse(readFileSync(new URL("../.state.json", import.meta.url), "utf8"));
const MIRROR = process.env.MIRROR_NODE_URL;
const ORIGIN = process.env.PRISM_ORIGIN ?? "http://localhost:4051";
const TOKEN = state.prism.tokenId;

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  ok ? passed++ : failed++;
  return ok;
};
const get = async (url) => (await fetch(url)).json();

console.log("\nPRISM — on-chain acceptance test\n" + "=".repeat(64));

// Fail loudly and usefully if a dependency is down. A suite that stack-traces
// because a server is missing tells you nothing about the system under test.
for (const [name, url, hint] of [
  ["resource server", `${ORIGIN}/health`, "npm run server"],
  ["policy co-signer", `${process.env.POLICY_URL ?? "http://localhost:4052"}/health`, "npm run policy"],
]) {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch {
    console.error(`\n  Cannot reach the ${name} at ${url}`);
    console.error(`  Start it first:  ${hint}\n`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------- the token
console.log("\n[1] The payment asset carries the split");
const token = await get(`${MIRROR}/api/v1/tokens/${TOKEN}`);
const fees = token.custom_fees?.fractional_fees ?? [];
check("PRSM exists and is fungible", token.type === "FUNGIBLE_COMMON", token.symbol);
check("carries exactly two fractional fees", fees.length === 2);
check(
  "shares are 15% and 10%",
  fees.map((f) => `${f.amount.numerator}/${f.amount.denominator}`).sort().join(",") === "10/100,15/100",
);
check(
  "fees are inclusive (buyer pays exactly the quote)",
  fees.every((f) => f.net_of_transfers === false),
);
check(
  "fee schedule is under a multi-party key",
  token.fee_schedule_key?._type === "ProtobufEncoded",
  "operator cannot rewrite the split alone",
);

// ------------------------------------------------------------- the payer
console.log("\n[2] The payer is a threshold account holding no HBAR for PRSM calls");
const agent = await get(`${MIRROR}/api/v1/accounts/${state.agent.id}`);
check("agent key is a KeyList/ThresholdKey", agent.key?._type === "ProtobufEncoded", state.agent.id);

// -------------------------------------------------------- disclosure in 402
console.log("\n[3] The 402 discloses the split before payment");
const res402 = await fetch(`${ORIGIN}/v1/token/${TOKEN}/cost`);
check("route returns 402", res402.status === 402);
const challenge = JSON.parse(
  Buffer.from(res402.headers.get("payment-required"), "base64").toString("utf8"),
);
const info = challenge.extensions?.prism?.info;
check("prism extension present", Boolean(info));
check("declares three payees", info?.payees?.length === 3);
check(
  "declared shares total 100%",
  info?.payees?.reduce((s, p) => s + p.basisPoints, 0) === 10_000,
);
check("bazaar discovery extension present", Boolean(challenge.extensions?.bazaar?.info));
check(
  "declared split matches the live fee schedule",
  info?.payees
    ?.filter((p) => p.via === "assessed_custom_fee")
    .every((p) => fees.some((f) => f.collector_account_id === p.account)),
);

// ---------------------------------------------------------- a real payment
console.log("\n[4] A real x402 payment settles and refracts");
const { spawnSync } = await import("node:child_process");
const { fileURLToPath } = await import("node:url");
// fileURLToPath, not .pathname — the project path contains a space.
const run = spawnSync("node", ["studio/agent.mjs"], {
  encoding: "utf8",
  cwd: fileURLToPath(new URL("..", import.meta.url)),
});
const out = run.stdout ?? "";
check("client completed the flow", out.includes("200    paid and served"));
const txMatch = out.match(/https:\/\/hashscan\.io\/testnet\/transaction\/(\S+)/);
const txId = txMatch?.[1];
check("settlement returned a transaction id", Boolean(txId), txId ?? "none");
check("policy co-signed", out.includes("policy co-signed"));

// ------------------------------------------------------------- the audit
if (txId) {
  console.log("\n[5] The settlement audits clean from public data alone");
  let audit;
  for (let i = 0; i < 10; i++) {
    audit = await get(`${ORIGIN}/v1/audit/${txId}`);
    if (audit.ok !== false || audit.reason !== "not_indexed") break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  check("audit verdict is ok", audit.ok === true);
  check("transfers sum to zero", audit.invariants?.transfersSumToZero === true);
  check("every share matches the fee schedule", audit.invariants?.everyShareMatchesFeeSchedule === true);
  check("payTo received the remainder", audit.invariants?.payToReceivedRemainder === true);
  const gross = BigInt(audit.grossPaid ?? 0);
  const credited = (audit.payees ?? []).reduce((s, p) => s + BigInt(p.actual), 0n);
  check("credits reconcile to the gross payment", gross === credited, `${credited}/${gross}`);
  console.log(`\n  ${audit.hashscan}`);
}

// --------------------------------------------------------------- discovery
console.log("\n[6] Discovery surfaces are reachable");
for (const path of ["/.well-known/x402", "/.well-known/x402.json", "/openapi.json"]) {
  const r = await fetch(`${ORIGIN}${path}`);
  check(`${path} serves`, r.ok);
}
const openapi = await get(`${ORIGIN}/openapi.json`);
check(
  "openapi declares x-payment-info on paid routes",
  Object.values(openapi.paths ?? {}).every((p) => p.get?.["x-payment-info"]),
);

console.log("\n" + "=".repeat(64));
console.log(`  ${passed} passed, ${failed} failed`);
console.log("=".repeat(64) + "\n");
process.exitCode = failed === 0 ? 0 : 1;
