/**
 * Reconcile every payment Prism has ever settled, from balances alone.
 *
 * Individual transactions can be cherry-picked; cumulative balances cannot. Each
 * collector's holdings imply the total gross volume that produced them, and the two
 * implications have to agree. If they do, the split has been applied consistently
 * across every payment — not just the ones anyone chose to link.
 *
 * Reads only the public mirror node. No keys, no local state beyond which accounts
 * to look at.
 */
import { readFileSync } from "node:fs";
import "dotenv/config";

const state = JSON.parse(readFileSync(new URL("../.state.json", import.meta.url), "utf8"));
const MIRROR = process.env.MIRROR_NODE_URL ?? "https://testnet.mirrornode.hedera.com";
const TOKEN = state.prism.tokenId;
const DECIMALS = 6;

const roles = [
  { role: "service", id: state.prism.service.id, share: 0.75, via: "payTo" },
  { role: "upstream", id: state.prism.upstream.id, share: 0.15, via: "assessed_custom_fee" },
  { role: "referrer", id: state.prism.referrer.id, share: 0.1, via: "assessed_custom_fee" },
];

async function balance(accountId) {
  const res = await fetch(`${MIRROR}/api/v1/accounts/${accountId}`);
  const body = await res.json();
  const t = (body.balance?.tokens ?? []).find((x) => x.token_id === TOKEN);
  return Number(t?.balance ?? 0);
}

const held = Object.fromEntries(
  await Promise.all(roles.map(async (r) => [r.role, await balance(r.id)])),
);

console.log(`\nPRISM — reconciliation from public balances\n${"=".repeat(64)}`);
console.log(`  token ${TOKEN}\n`);
for (const r of roles) {
  console.log(`  ${r.role.padEnd(9)} ${r.id.padEnd(13)} ${String((r.share * 100).toFixed(0) + "%").padStart(4)}   ${String(held[r.role]).padStart(9)}`);
}

// Each collector independently implies a gross volume. They must agree.
const implied = roles
  .filter((r) => r.via === "assessed_custom_fee")
  .map((r) => ({ role: r.role, gross: held[r.role] / r.share }));

console.log(`\n  implied gross volume, derived independently:`);
for (const i of implied) console.log(`    from ${i.role.padEnd(9)} ${i.gross.toLocaleString('en-US')}`);

const agree = implied.every((i) => Math.abs(i.gross - implied[0].gross) < 1);
const gross = implied[0].gross;
console.log(`    collectors agree: ${agree ? "yes" : "NO — the split is not being applied consistently"}`);

const expectedService = gross * 0.75;
const gap = held.service - expectedService;
console.log(`\n  service expected  ${expectedService.toLocaleString('en-US')}`);
console.log(`  service actual    ${held.service.toLocaleString('en-US')}`);
console.log(`  gap               ${gap.toLocaleString('en-US')}`);

const price = 0.02 * 10 ** DECIMALS;
if (gap === 0) {
  console.log(`\n  Every payment split. ${(gross / price).toFixed(0)} payments of $0.02.`);
} else if (gap > 0 && gap % price === 0) {
  // Expected, and worth surfacing: the treasury and every collector are permanently
  // exempt from the token's own fees, so a payment from one of them does not split.
  console.log(
    `\n  ${gap / price} payment(s) reached the service without splitting — consistent with`,
  );
  console.log(`  a fee-exempt payer (the treasury or a collector). See "Known limits".`);
  console.log(`  ${(gross / price).toFixed(0)} payments did split.`);
} else {
  console.log(`\n  Unexplained gap — not a whole number of $0.02 payments. Investigate.`);
}
console.log(`${"=".repeat(64)}\n`);
process.exitCode = agree ? 0 : 1;
