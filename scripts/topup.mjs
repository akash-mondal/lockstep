/**
 * Sweep HBAR from a funding account into the Prism operator.
 *
 * The funder key is read from the FUNDER_KEY env var and never written to disk —
 * pass it inline for a single run:
 *
 *   FUNDER_KEY=0x… node scripts/topup.mjs
 *
 * Leaves a small reserve behind so the funder can still pay the transfer fee.
 */
import "dotenv/config";
import {
  AccountBalanceQuery,
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  TransferTransaction,
} from "@hiero-ledger/sdk";

const { FUNDER_KEY, OPERATOR_ID, MIRROR_NODE_URL } = process.env;
const RESERVE = new Hbar(1); // enough for the transfer fee, with slack

if (!FUNDER_KEY) {
  console.error("Set FUNDER_KEY inline, e.g. FUNDER_KEY=0x… node scripts/topup.mjs");
  process.exit(1);
}
if (!OPERATOR_ID) {
  console.error("No OPERATOR_ID in .env — run `npm run whoami` first.");
  process.exit(1);
}

const funderKey = PrivateKey.fromStringECDSA(FUNDER_KEY);
const funderEvm = `0x${funderKey.publicKey.toEvmAddress()}`;

// The key alone doesn't tell us the account id; resolve it from the mirror node.
const lookup = await fetch(`${MIRROR_NODE_URL}/api/v1/accounts/${funderEvm}`);
if (!lookup.ok) {
  console.error(`No testnet account found for funder ${funderEvm} (HTTP ${lookup.status}).`);
  process.exit(1);
}
const funderId = (await lookup.json()).account;

const client = Client.forTestnet().setOperator(AccountId.fromString(funderId), funderKey);

try {
  const balance = await new AccountBalanceQuery().setAccountId(funderId).execute(client);
  const sendable = balance.hbars.toBigNumber().minus(RESERVE.toBigNumber());

  console.log(`Funder    : ${funderId}  (${funderEvm})`);
  console.log(`Balance   : ${balance.hbars.toString()}`);
  console.log(`Recipient : ${OPERATOR_ID}`);

  if (sendable.lte(0)) {
    console.error(`\nNothing to sweep — balance is at or below the ${RESERVE.toString()} reserve.`);
    process.exit(1);
  }

  const amount = Hbar.fromString(sendable.toFixed(8));
  console.log(`Sweeping  : ${amount.toString()} (leaving ${RESERVE.toString()} for fees)\n`);

  const receipt = await new TransferTransaction()
    .addHbarTransfer(funderId, amount.negated())
    .addHbarTransfer(OPERATOR_ID, amount)
    .execute(client)
    .then((r) => r.getReceipt(client));

  console.log(`Transfer status: ${receipt.status}`);
} catch (err) {
  console.error(`Transfer failed: ${err?.message ?? err}`);
  process.exitCode = 1;
} finally {
  client.close();
}
