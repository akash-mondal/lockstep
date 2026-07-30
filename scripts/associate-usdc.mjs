/**
 * Associate the operator with Hedera testnet USDC (0.0.429274).
 *
 * Hedera requires an explicit association before an account can receive an HTS
 * token, unless it has free auto-association slots. Circle's faucet will not
 * deliver to an unassociated account. Needs HBAR for the fee, so run this only
 * after `npm run whoami` shows a balance.
 */
import "dotenv/config";
import {
  AccountId,
  Client,
  PrivateKey,
  TokenAssociateTransaction,
  TokenId,
} from "@hiero-ledger/sdk";

const { OPERATOR_ID, OPERATOR_KEY, USDC_TOKEN_ID } = process.env;
if (!OPERATOR_ID || !OPERATOR_KEY) {
  console.error("Need OPERATOR_ID and OPERATOR_KEY in .env — run `npm run whoami` after funding.");
  process.exit(1);
}

const client = Client.forTestnet().setOperator(
  AccountId.fromString(OPERATOR_ID),
  PrivateKey.fromStringECDSA(OPERATOR_KEY),
);

try {
  const receipt = await new TokenAssociateTransaction()
    .setAccountId(AccountId.fromString(OPERATOR_ID))
    .setTokenIds([TokenId.fromString(USDC_TOKEN_ID)])
    .execute(client)
    .then((r) => r.getReceipt(client));
  console.log(`Associated ${OPERATOR_ID} with USDC ${USDC_TOKEN_ID}: ${receipt.status}`);
} catch (err) {
  const msg = String(err?.message ?? err);
  if (msg.includes("TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT")) {
    console.log("Already associated — nothing to do.");
  } else {
    console.error(`Association failed: ${msg}`);
    process.exitCode = 1;
  }
} finally {
  client.close();
}
