/**
 * Resolve the operator's 0.0.x account id once funding has auto-created it,
 * report balances, and write OPERATOR_ID back into .env.
 *
 * The mirror node lags consensus by a beat, so a 404 right after funding means
 * "not yet", not "failed".
 */
import { readFileSync, writeFileSync } from "node:fs";
import "dotenv/config";

const { OPERATOR_EVM_ADDRESS, MIRROR_NODE_URL, USDC_TOKEN_ID } = process.env;
if (!OPERATOR_EVM_ADDRESS) {
  console.error("No OPERATOR_EVM_ADDRESS in .env — run `npm run keygen` first.");
  process.exit(1);
}

const res = await fetch(`${MIRROR_NODE_URL}/api/v1/accounts/${OPERATOR_EVM_ADDRESS}`);
if (res.status === 404) {
  console.log(`Not funded yet: ${OPERATOR_EVM_ADDRESS}`);
  console.log("Send testnet HBAR to that address, then run this again.");
  process.exit(0);
}
if (!res.ok) {
  console.error(`Mirror node returned ${res.status}`);
  process.exit(1);
}

const acct = await res.json();
const hbar = Number(acct.balance?.balance ?? 0) / 1e8;
const autoAssoc = acct.max_automatic_token_associations;

console.log(`Account id   : ${acct.account}`);
console.log(`EVM address  : ${OPERATOR_EVM_ADDRESS}`);
console.log(`HBAR balance : ${hbar}`);
console.log(`Auto-assoc   : ${autoAssoc} ${autoAssoc === -1 ? "(unlimited)" : autoAssoc === 0 ? "(none — USDC needs an explicit association)" : ""}`);

const tokens = acct.balance?.tokens ?? [];
const usdc = tokens.find((t) => t.token_id === USDC_TOKEN_ID);
console.log(`USDC         : ${usdc ? `${Number(usdc.balance) / 1e6} (associated)` : "not associated"}`);

const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
writeFileSync(
  new URL("../.env", import.meta.url),
  env.replace(/^OPERATOR_ID=.*$/m, `OPERATOR_ID=${acct.account}`),
);
console.log("\nOPERATOR_ID written to .env.");
