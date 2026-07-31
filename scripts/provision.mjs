/**
 * Create the account the resource server is paid at.
 *
 * This is all that remains of what used to be phase 1. That script also minted a
 * token whose fee schedule carried a three way revenue split, because the split
 * was the mechanism the project was built on. Lockstep settles in native HBAR
 * now, and HBAR has no fee schedule: a custom fee is a field on a token record,
 * so there is nothing to mint and nothing to split. The analysis of why, and the
 * `FAIL_INVALID` behaviour found while proving it, is kept in HEDERA.md.
 *
 * What is still needed is mundane: an account to be paid at, created with
 * unlimited auto association so it can receive anything sent to it without a
 * prior association step.
 *
 *   npm run provision
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { AccountCreateTransaction, AccountId, Client, Hbar, PrivateKey } from "@hiero-ledger/sdk";
import { requireOperator, requireState } from "./_prereq.mjs";

const { OPERATOR_ID, OPERATOR_KEY } = requireOperator();
const STATE_PATH = new URL("../.state.json", import.meta.url);
const state = requireState([["agent.id", "Gate 2", "npm run gate2"]]);

const client = Client.forTestnet().setOperator(
  AccountId.fromString(OPERATOR_ID),
  PrivateKey.fromStringECDSA(OPERATOR_KEY),
);

async function party(role) {
  if (state.lockstep?.[role]) {
    const p = state.lockstep[role];
    console.log(`    ${role.padEnd(9)} ${p.id}  (reused)`);
    return { id: p.id, key: PrivateKey.fromStringECDSA(p.key) };
  }
  const key = PrivateKey.generateECDSA();
  const receipt = await new AccountCreateTransaction()
    .setKeyWithoutAlias(key.publicKey)
    .setInitialBalance(new Hbar(0))
    // Without this an inbound token transfer fails at consensus with
    // TOKEN_NOT_ASSOCIATED_TO_ACCOUNT, after the facilitator has already
    // verified the payment. Nothing here is paid in tokens, but an account that
    // silently cannot receive one is a trap to leave lying around.
    .setMaxAutomaticTokenAssociations(-1)
    .execute(client)
    .then((r) => r.getReceipt(client));
  const id = receipt.accountId.toString();
  state.lockstep = { ...(state.lockstep ?? {}), [role]: { id, key: key.toStringRaw() } };
  console.log(`    ${role.padEnd(9)} ${id}`);
  return { id, key };
}

try {
  console.log("\nProvisioning the resource server's payee\n" + "=".repeat(56));
  const service = await party("service");
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

  console.log(`\n  payTo       ${service.id}`);
  console.log("  asset       0.0.0 (native HBAR)");
  console.log("\n  Written to .state.json. Next: npm run up, then npm run agent.\n");
} finally {
  client.close();
}
