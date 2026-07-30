/**
 * GATE 1 — does an HTS fractional custom fee actually refract a transfer,
 * and does it show up in the mirror-node record as `assessed_custom_fees`?
 *
 * Lockstep's entire claim is that one payment pays several parties atomically, with
 * the split assessed at consensus and reported in the record. Every part of that
 * is documented in HIP-18/573 and custom_fees.proto — but a survey of 800 recent
 * testnet transfers and 600 mainnet transfers found *zero* carrying assessed
 * custom fees, so nothing observable confirms the read-back path works. This
 * script produces the missing evidence.
 *
 * Why four accounts: the token treasury and a fee's own collector are always
 * exempt from that fee, so the transfer under test has to run between two
 * accounts that are neither.
 *
 *   operator (treasury)  --1000-->  buyer  --100-->  seller
 *                                            \--10--> collector   (assessed, not signed)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import "dotenv/config";
import { requireOperator } from "./_prereq.mjs";
import {
  AccountCreateTransaction,
  AccountId,
  Client,
  CustomFractionalFee,
  FeeAssessmentMethod,
  Hbar,
  PrivateKey,
  TokenAssociateTransaction,
  TokenCreateTransaction,
  TokenFeeScheduleUpdateTransaction,
  TokenSupplyType,
  TokenType,
  TransferTransaction,
} from "@hiero-ledger/sdk";

const { MIRROR_NODE_URL } = process.env;
const { OPERATOR_ID, OPERATOR_KEY } = requireOperator();

const DECIMALS = 6;
const UNIT = 10 ** DECIMALS;
const FEE_NUMERATOR = 1;
const FEE_DENOMINATOR = 10; // 10%
const SEED_BUYER = 1000 * UNIT;
const PAYMENT = 100 * UNIT;
const EXPECTED_FEE = (PAYMENT * FEE_NUMERATOR) / FEE_DENOMINATOR;

const operatorKey = PrivateKey.fromStringECDSA(OPERATOR_KEY);
const client = Client.forTestnet().setOperator(AccountId.fromString(OPERATOR_ID), operatorKey);

const STATE_PATH = new URL("../.state.json", import.meta.url);
// Reuse participants across reruns — each account costs real HBAR to create.
const state = existsSync(STATE_PATH)
  ? JSON.parse(readFileSync(STATE_PATH, "utf8"))
  : { operator: OPERATOR_ID };
const step = (n, msg) => console.log(`\n[${n}] ${msg}`);

/** SDK renders `0.0.x@secs.nanos`; the mirror node wants `0.0.x-secs-nanos`. */
const toMirrorTxId = (id) => id.toString().replace("@", "-").replace(/\.(\d+)$/, "-$1");

/** Mirror node trails consensus by a beat, so an early 404 means "not yet". */
async function fetchRecord(mirrorId, attempts = 12) {
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(`${MIRROR_NODE_URL}/api/v1/transactions/${mirrorId}`);
    if (res.ok) {
      const body = await res.json();
      if (body.transactions?.length) return body.transactions[0];
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`mirror node never returned a record for ${mirrorId}`);
}

async function makeAccount(label) {
  if (state[label]?.id) {
    const existing = state[label];
    console.log(`    ${label.padEnd(9)} ${existing.id}  (reused)`);
    return { id: existing.id, key: PrivateKey.fromStringECDSA(existing.key) };
  }
  const key = PrivateKey.generateECDSA();
  const receipt = await new AccountCreateTransaction()
    .setKeyWithoutAlias(key.publicKey)
    .setInitialBalance(new Hbar(0)) // holds no HBAR — the facilitator sponsors fees
    .setMaxAutomaticTokenAssociations(-1) // unlimited, so it can receive without pre-association
    .execute(client)
    .then((r) => r.getReceipt(client));
  const id = receipt.accountId.toString();
  console.log(`    ${label.padEnd(9)} ${id}  (0 HBAR, unlimited auto-assoc)`);
  state[label] = { id, key: key.toStringRaw() };
  return { id, key };
}

try {
  step(1, "Creating participants");
  const collector = await makeAccount("collector");
  const buyer = await makeAccount("buyer");
  const seller = await makeAccount("seller");

  step(2, `Creating token with a ${FEE_NUMERATOR}/${FEE_DENOMINATOR} fractional fee to the collector`);
  const fee = new CustomFractionalFee()
    .setNumerator(FEE_NUMERATOR)
    .setDenominator(FEE_DENOMINATOR)
    .setFeeCollectorAccountId(collector.id)
    // Inclusive == net_of_transfers:false. The quoted price is gross: the receiver
    // lands amount-minus-fee, so the buyer is never debited more than it agreed to.
    .setAssessmentMethod(FeeAssessmentMethod.Inclusive);

  const feeScheduleKey = state.feeScheduleKey
    ? PrivateKey.fromStringECDSA(state.feeScheduleKey)
    : PrivateKey.generateECDSA();
  state.feeScheduleKey = feeScheduleKey.toStringRaw();

  const build = (withFees) => {
    const tx = new TokenCreateTransaction()
      .setTokenName("Lockstep Gate 1")
      .setTokenSymbol("PRZG1")
      .setTokenType(TokenType.FungibleCommon)
      .setSupplyType(TokenSupplyType.Infinite)
      .setDecimals(DECIMALS)
      .setInitialSupply(1_000_000 * UNIT)
      .setTreasuryAccountId(OPERATOR_ID)
      .setSupplyKey(operatorKey.publicKey)
      .setFeeScheduleKey(feeScheduleKey.publicKey);
    return withFees ? tx.setCustomFees([fee]) : tx;
  };

  // A fee collector must consent to being named, so it signs the create alongside
  // the treasury. Without this the network rejects with INVALID_SIGNATURE.
  const signCreate = (tx) =>
    tx.freezeWith(client).sign(collector.key).then((t) => t.execute(client));

  let tokenId;
  try {
    const receipt = await signCreate(build(true)).then((r) => r.getReceipt(client));
    tokenId = receipt.tokenId.toString();
    console.log(`    token ${tokenId} created with the fee attached`);
  } catch (err) {
    // The known trap: collectors must be associated before the fee can name them.
    // Unlimited auto-association should cover it; if not, fall back to attaching
    // the fee after an explicit association.
    if (!String(err?.message).includes("TOKEN_NOT_ASSOCIATED_TO_FEE_COLLECTOR")) throw err;
    console.log("    collector was not auto-associated — falling back to create → associate → update");
    const receipt = await signCreate(build(false)).then((r) => r.getReceipt(client));
    tokenId = receipt.tokenId.toString();
    await new TokenAssociateTransaction()
      .setAccountId(collector.id)
      .setTokenIds([tokenId])
      .freezeWith(client)
      .sign(collector.key)
      .then((t) => t.execute(client))
      .then((r) => r.getReceipt(client));
    await new TokenFeeScheduleUpdateTransaction()
      .setTokenId(tokenId)
      .setCustomFees([fee])
      .freezeWith(client)
      .sign(feeScheduleKey)
      .then((t) => t.sign(collector.key))
      .then((t) => t.execute(client))
      .then((r) => r.getReceipt(client));
    console.log(`    token ${tokenId} created, collector associated, fee attached`);
  }
  state.tokenId = tokenId;

  step(3, `Seeding the buyer with ${SEED_BUYER / UNIT} tokens from the treasury (exempt — no fee expected)`);
  await new TransferTransaction()
    .addTokenTransfer(tokenId, OPERATOR_ID, -SEED_BUYER)
    .addTokenTransfer(tokenId, buyer.id, SEED_BUYER)
    .execute(client)
    .then((r) => r.getReceipt(client));
  console.log("    seeded");

  step(4, `The transfer under test: buyer pays seller ${PAYMENT / UNIT} tokens`);
  console.log("    the signed body credits the seller the full amount and names no collector");
  const paymentResponse = await new TransferTransaction()
    .addTokenTransfer(tokenId, buyer.id, -PAYMENT)
    .addTokenTransfer(tokenId, seller.id, PAYMENT)
    .freezeWith(client)
    .sign(buyer.key)
    .then((t) => t.execute(client));
  await paymentResponse.getReceipt(client);

  const mirrorId = toMirrorTxId(paymentResponse.transactionId);
  state.paymentTxId = mirrorId;
  console.log(`    submitted: ${mirrorId}`);

  step(5, "Reading the record back from the public mirror node");
  const record = await fetchRecord(mirrorId);
  const assessed = record.assessed_custom_fees ?? [];
  const transfers = (record.token_transfers ?? []).filter((t) => t.token_id === tokenId);

  console.log("\n  token_transfers (merged, post-assessment):");
  for (const t of transfers) {
    const who =
      t.account === buyer.id ? "buyer" : t.account === seller.id ? "seller" : t.account === collector.id ? "collector" : t.account;
    console.log(`    ${who.padEnd(10)} ${String(t.amount).padStart(12)}  (${t.amount / UNIT})`);
  }

  console.log("\n  assessed_custom_fees:");
  console.log(assessed.length ? JSON.stringify(assessed, null, 4) : "    (empty)");

  const toCollector = assessed.find((f) => f.collector_account_id === collector.id);
  const sellerNet = transfers.find((t) => t.account === seller.id)?.amount;

  console.log("\n" + "=".repeat(66));
  const rendered = assessed.length > 0;
  const correctAmount = Number(toCollector?.amount) === EXPECTED_FEE;
  const sellerReduced = sellerNet === PAYMENT - EXPECTED_FEE;

  console.log(`  assessed_custom_fees present    : ${rendered ? "YES" : "NO"}`);
  console.log(`  collector credited ${EXPECTED_FEE / UNIT} tokens   : ${correctAmount ? "YES" : `NO (${toCollector?.amount})`}`);
  console.log(`  seller received ${(PAYMENT - EXPECTED_FEE) / UNIT} (net of fee) : ${sellerReduced ? "YES" : `NO (${sellerNet})`}`);
  // The mirror node returns `effective_payer_account_ids` (plural array), not the
  // singular `effective_payer_account_id` the protobuf docs describe.
  const payers = toCollector?.effective_payer_account_ids ?? [];
  const payerRole = payers.includes(seller.id) ? "seller (receiver)" : payers.includes(buyer.id) ? "buyer (sender)" : "?";
  console.log(`  effective payer                 : ${payers.join(", ") || "n/a"}  → ${payerRole}`);
  console.log("=".repeat(66));
  console.log(rendered && correctAmount && sellerReduced ? "  GATE 1 PASSED" : "  GATE 1 FAILED");
  console.log("=".repeat(66));
  console.log(`\n  HashScan: https://hashscan.io/testnet/transaction/${mirrorId}`);
} catch (err) {
  console.error(`\nGate 1 errored: ${err?.message ?? err}`);
  process.exitCode = 1;
} finally {
  writeFileSync(new URL("../.state.json", import.meta.url), JSON.stringify(state, null, 2));
  console.log("\n(participants + token written to .state.json)");
  client.close();
}
