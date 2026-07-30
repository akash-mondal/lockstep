/**
 * Mint PRISM, the token Prism Studio sells finished videos in.
 *
 * The split is a property of the token, so these numbers are a one-shot
 * decision: changing them later needs two of the three payees to sign a
 * TokenFeeScheduleUpdate. That is why the arithmetic comes first.
 *
 *   studio        50%   via payTo, the remainder after fees
 *   upstream      35%   via assessed_custom_fee
 *   referrer      15%   via assessed_custom_fee
 *
 * These are payees, not spenders, and that is not a compromise. A fee collector
 * on Hedera is structurally terminal: it cannot forward to a non-exempt account,
 * because under Inclusive assessment the receiver bears the fee and the network
 * will not let a collector collect on a payment it is itself making. Every payee
 * in a real revenue split is terminal anyway, so the protocol and the economics
 * agree. See HEDERA.md for the failure this was learned from.
 *
 * The two rails therefore do different jobs and must not be confused:
 * refraction pays the value chain, while ordinary x402 calls pay cost of goods.
 * The studio buys each asset from the foundry per call, in HBAR, and every one
 * of those is its own settlement that appears in the receipt.
 *
 *   node scripts/mint-studio.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import "dotenv/config";
import { requireOperator } from "./_prereq.mjs";
import {
  AccountCreateTransaction,
  AccountId,
  Client,
  CustomFractionalFee,
  FeeAssessmentMethod,
  Hbar,
  KeyList,
  PrivateKey,
  TokenCreateTransaction,
  TokenSupplyType,
  TokenType,
} from "@hiero-ledger/sdk";

const { MIRROR_NODE_URL } = process.env;
const { OPERATOR_ID, OPERATOR_KEY } = requireOperator();
const STATE_PATH = new URL("../.state.json", import.meta.url);
const state = JSON.parse(readFileSync(STATE_PATH, "utf8"));

const DECIMALS = 6;
const UNIT = 10 ** DECIMALS;
// 1 STUD is nominally 1 HBAR so the foundry can quote the same number in either
// asset and the studio's books stay in one unit.
const SHARES = [
  { role: "upstream", numerator: 35, denominator: 100 },
  { role: "referrer", numerator: 15, denominator: 100 },
];

const operatorKey = PrivateKey.fromStringECDSA(OPERATOR_KEY.replace(/^0x/, ""));
const client = Client.forTestnet().setOperator(AccountId.fromString(OPERATOR_ID), operatorKey);
const step = (n, m) => console.log(`\n[${n}] ${m}`);

async function party(role) {
  if (state.studio?.[role]) {
    const p = state.studio[role];
    console.log(`    ${role.padEnd(9)} ${p.id}  (reused)`);
    return { id: p.id, key: PrivateKey.fromStringECDSA(p.key) };
  }
  const key = PrivateKey.generateECDSA();
  const receipt = await new AccountCreateTransaction()
    .setKeyWithoutAlias(key.publicKey)
    .setInitialBalance(new Hbar(0))
    // -1 means unlimited auto-association, which satisfies the requirement that
    // a fee collector be associated with the token at creation time.
    .setMaxAutomaticTokenAssociations(-1)
    .execute(client)
    .then((r) => r.getReceipt(client));
  const id = receipt.accountId.toString();
  state.studio = { ...(state.studio ?? {}), [role]: { id, key: key.toStringRaw() } };
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(`    ${role.padEnd(9)} ${id}`);
  return { id, key };
}

try {
  step(1, "Creating the three parties paid by every PRISM transfer");
  const studio = await party("studio");
  const upstream = await party("upstream");
  const referrer = await party("referrer");

  step(2, "Building the 2-of-3 ThresholdKey that governs the fee schedule");
  const feeScheduleKey = new KeyList(
    [studio.key.publicKey, upstream.key.publicKey, referrer.key.publicKey],
    2,
  );
  console.log("    changing the split needs 2 of {studio, upstream, referrer}");
  console.log("    the operator alone cannot rewrite who gets paid");

  step(3, "Minting PRISM with the split in its fee schedule");
  if (state.studio?.tokenId) {
    console.log(`    token ${state.studio.tokenId} already minted, skipping`);
  } else {
    const collector = { upstream: upstream.id, referrer: referrer.id };
    const fees = SHARES.map(({ role, numerator, denominator }) =>
      new CustomFractionalFee()
        .setNumerator(numerator)
        .setDenominator(denominator)
        .setFeeCollectorAccountId(collector[role])
        // Inclusive: the buyer is debited exactly the quote, and the shares come
        // out of the studio's take rather than being charged on top.
        .setAssessmentMethod(FeeAssessmentMethod.Inclusive)
        // Collectors do not pay each other's fees when moving their own earnings.
        .setAllCollectorsAreExempt(true),
    );
    for (const { role, numerator, denominator } of SHARES) {
      console.log(`    ${role.padEnd(9)} ${numerator}/${denominator}  -> ${collector[role]}`);
    }
    console.log(`    studio    50/100  -> ${studio.id} (payTo, the remainder)`);

    // Naming a collector is not enough: it has to consent, or the network
    // returns INVALID_SIGNATURE. Undocumented in the HIPs and the SDK docs.
    const receipt = await new TokenCreateTransaction()
      .setTokenName("Prism")
      .setTokenSymbol("PRISM")
      // An admin key, so the name is not a one-way door. The first mint had none
      // and its symbol became permanent the moment it was created.
      .setAdminKey(operatorKey.publicKey)
      .setTokenType(TokenType.FungibleCommon)
      .setSupplyType(TokenSupplyType.Infinite)
      .setDecimals(DECIMALS)
      .setInitialSupply(10_000_000 * UNIT)
      .setTreasuryAccountId(OPERATOR_ID)
      .setSupplyKey(operatorKey.publicKey)
      .setFeeScheduleKey(feeScheduleKey)
      .setCustomFees(fees)
      .setTokenMemo("Prism Studio — a sale funds the next production, at consensus")
      .freezeWith(client)
      .sign(upstream.key)
      .then((t) => t.sign(referrer.key))
      .then((t) => t.execute(client))
      .then((r) => r.getReceipt(client));
    state.studio.tokenId = receipt.tokenId.toString();
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    console.log(`    minted ${state.studio.tokenId}`);
  }
  const tokenId = state.studio.tokenId;

  step(4, "Reading it back from the public mirror node");
  let info;
  for (let i = 0; i < 12; i++) {
    const res = await fetch(`${MIRROR_NODE_URL}/api/v1/tokens/${tokenId}`);
    if (res.ok) {
      info = await res.json();
      if (info.custom_fees?.fractional_fees?.length) break;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!info?.custom_fees?.fractional_fees?.length) {
    throw new Error("the mirror node has not indexed the fee schedule yet");
  }
  for (const f of info.custom_fees.fractional_fees) {
    const pct = (Number(f.amount.numerator) / Number(f.amount.denominator)) * 100;
    console.log(
      `    ${String(pct.toFixed(0) + "%").padStart(4)} -> ${f.collector_account_id}` +
      `  net_of_transfers=${f.net_of_transfers}  exempt=${f.all_collectors_are_exempt}`,
    );
  }
  console.log(`    fee schedule key: ${info.fee_schedule_key?._type}`);
  console.log(`\n    https://hashscan.io/testnet/token/${tokenId}`);

  step(5, "What this prices");
  const SKU = { image: 0.25, speech: 0.05, music: 0.5, transcribe: 0.1 };
  for (const scenes of [3, 6, 12]) {
    const cost = scenes * SKU.image + SKU.speech + SKU.music + SKU.transcribe;
    const quote = Math.ceil((cost / 0.35) * 1.3 * 100) / 100;
    console.log(
      `    ${String(scenes).padStart(2)} scenes  cost ${cost.toFixed(2)}  ` +
      `quote ${quote.toFixed(2)}  upstream gets ${(quote * 0.35).toFixed(2)}`,
    );
  }
} catch (err) {
  console.error(`\nmint failed: ${err?.message ?? err}`);
  process.exitCode = 1;
} finally {
  client.close();
}
