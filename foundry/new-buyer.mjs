/**
 * Create a buyer account for testing the foundry.
 *
 * The seller cannot be the buyer: a transfer from an account to itself is not a
 * payment, and the `exact` scheme's checks would reject the shape anyway. So the
 * foundry operator funds a separate account, which is what an agent's wallet
 * would be in real use.
 *
 *   node foundry/new-buyer.mjs [hbar]
 *
 * Prints the id and key. Put both in .env as BUYER_ID and BUYER_KEY.
 */
import "dotenv/config";
import {
  AccountCreateTransaction, AccountId, Client, Hbar, HbarUnit, PrivateKey,
} from "@hiero-ledger/sdk";

const OP_ID = process.env.FOUNDRY_OPERATOR_ID;
const OP_KEY = process.env.FOUNDRY_OPERATOR_KEY;
if (!OP_ID || !OP_KEY) {
  console.error("FOUNDRY_OPERATOR_ID and FOUNDRY_OPERATOR_KEY are required.");
  process.exit(1);
}

const fund = Number(process.argv[2] ?? 20);
const client = Client.forTestnet().setOperator(
  AccountId.fromString(OP_ID),
  PrivateKey.fromStringECDSA(OP_KEY.replace(/^0x/, "")),
);

try {
  // ECDSA, because @x402/hedera's live path and both public facilitators assume
  // it for the client and the fee payer.
  const key = PrivateKey.generateECDSA();
  const tx = await new AccountCreateTransaction()
    .setECDSAKeyWithAlias(key)
    .setInitialBalance(Hbar.from(fund, HbarUnit.Hbar))
    .execute(client);
  const receipt = await tx.getReceipt(client);
  const id = receipt.accountId.toString();

  console.log(`buyer created`);
  console.log(`  BUYER_ID=${id}`);
  console.log(`  BUYER_KEY=0x${key.toStringRaw()}`);
  console.log(`  funded ${fund} ℏ from ${OP_ID}`);
  console.log(`  https://hashscan.io/testnet/account/${id}`);
} catch (err) {
  console.error(`could not create the buyer: ${err?.message ?? err}`);
  process.exitCode = 1;
} finally {
  client.close();
}
