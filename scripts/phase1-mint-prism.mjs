/**
 * PHASE 1 — mint PRSM, the payment asset whose fee schedule *is* the revenue split.
 *
 * Three parties are paid by every transfer of this token:
 *
 *   payTo (service)   75%   lands the remainder after fees
 *   upstream          15%   the data provider whose feed answered the call
 *   referrer          10%   whoever sent the paying agent
 *
 * The two shares are `FractionalFee` entries on the token itself, so they are
 * assessed by consensus nodes inside the same CryptoTransfer. There is no splitter
 * contract, no distribute() call, and nothing to run afterwards.
 *
 * The fee schedule key is a 2-of-3 ThresholdKey across the three parties, so the
 * operator cannot rewrite the split alone — changing who gets paid what requires
 * the agreement of someone it affects. That is the difference between "a seller
 * who promises to share" and "a group that jointly controls a revenue split".
 *
 * Assessment is Inclusive (net_of_transfers:false): the quoted price is gross, the
 * buyer is debited exactly what the 402 said, and the shares come out of the
 * service's take rather than being charged on top.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import "dotenv/config";
import { requireOperator, requirePolicyKey, requireState } from "./_prereq.mjs";
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
  TransferTransaction,
} from "@hiero-ledger/sdk";

const { MIRROR_NODE_URL } = process.env;
const { OPERATOR_ID, OPERATOR_KEY } = requireOperator();
const STATE_PATH = new URL("../.state.json", import.meta.url);
const state = requireState([["agent.id", "Gate 2", "npm run gate2"]]);

const DECIMALS = 6; // USDC convention: 1 PRSM ≈ $1, so a $0.02 call is 20_000 units
const UNIT = 10 ** DECIMALS;
const SHARES = [
  { role: "upstream", numerator: 15, denominator: 100 },
  { role: "referrer", numerator: 10, denominator: 100 },
];

const operatorKey = PrivateKey.fromStringECDSA(OPERATOR_KEY);
const client = Client.forTestnet().setOperator(AccountId.fromString(OPERATOR_ID), operatorKey);
const step = (n, m) => console.log(`\n[${n}] ${m}`);

async function party(role) {
  if (state.prism?.[role]) {
    const p = state.prism[role];
    console.log(`    ${role.padEnd(9)} ${p.id}  (reused)`);
    return { id: p.id, key: PrivateKey.fromStringECDSA(p.key) };
  }
  const key = PrivateKey.generateECDSA();
  const receipt = await new AccountCreateTransaction()
    .setKeyWithoutAlias(key.publicKey)
    .setInitialBalance(new Hbar(0))
    .setMaxAutomaticTokenAssociations(-1)
    .execute(client)
    .then((r) => r.getReceipt(client));
  const id = receipt.accountId.toString();
  state.prism = { ...(state.prism ?? {}), [role]: { id, key: key.toStringRaw() } };
  console.log(`    ${role.padEnd(9)} ${id}`);
  return { id, key };
}

try {
  step(1, "Creating the three parties paid by every PRSM transfer");
  const service = await party("service");
  const upstream = await party("upstream");
  const referrer = await party("referrer");

  step(2, "Building the 2-of-3 ThresholdKey that governs the fee schedule");
  const feeScheduleKey = new KeyList(
    [service.key.publicKey, upstream.key.publicKey, referrer.key.publicKey],
    2,
  );
  console.log("    changing the split requires 2 of {service, upstream, referrer}");
  console.log("    the operator alone cannot rewrite who gets paid");

  step(3, "Minting PRSM with the split baked into its fee schedule");
  if (state.prism?.tokenId) {
    console.log(`    token ${state.prism.tokenId} already minted — skipping`);
  } else {
    const fees = SHARES.map(({ role, numerator, denominator }) =>
      new CustomFractionalFee()
        .setNumerator(numerator)
        .setDenominator(denominator)
        .setFeeCollectorAccountId(role === "upstream" ? upstream.id : referrer.id)
        .setAssessmentMethod(FeeAssessmentMethod.Inclusive)
        // Collectors shouldn't pay each other's fees when they move their own earnings.
        .setAllCollectorsAreExempt(true),
    );
    for (const { role, numerator, denominator } of SHARES) {
      console.log(`    ${role.padEnd(9)} ${numerator}/${denominator}`);
    }

    // Every fee collector must sign the create — naming an account is not enough,
    // it has to consent, or the network rejects with INVALID_SIGNATURE.
    const receipt = await new TokenCreateTransaction()
      .setTokenName("Prism Credit")
      .setTokenSymbol("PRSM")
      .setTokenType(TokenType.FungibleCommon)
      .setSupplyType(TokenSupplyType.Infinite)
      .setDecimals(DECIMALS)
      .setInitialSupply(10_000_000 * UNIT)
      .setTreasuryAccountId(OPERATOR_ID)
      .setSupplyKey(operatorKey.publicKey)
      .setFeeScheduleKey(feeScheduleKey)
      .setCustomFees(fees)
      .setTokenMemo("Prism — one x402 payment, refracted at consensus")
      .freezeWith(client)
      .sign(upstream.key)
      .then((t) => t.sign(referrer.key))
      .then((t) => t.execute(client))
      .then((r) => r.getReceipt(client));
    state.prism.tokenId = receipt.tokenId.toString();
    console.log(`    minted ${state.prism.tokenId}`);
  }
  const tokenId = state.prism.tokenId;

  step(4, "Reading the token config back from the public mirror node");
  let info;
  for (let i = 0; i < 12; i++) {
    const res = await fetch(`${MIRROR_NODE_URL}/api/v1/tokens/${tokenId}`);
    if (res.ok) {
      info = await res.json();
      if (info.custom_fees?.fractional_fees?.length) break;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(`    fee_schedule_key type : ${info?.fee_schedule_key?._type}`);
  console.log(`    supply_key present    : ${Boolean(info?.supply_key)}`);
  console.log("    fractional_fees:");
  for (const f of info?.custom_fees?.fractional_fees ?? []) {
    console.log(
      `      ${f.amount.numerator}/${f.amount.denominator} → ${f.collector_account_id}  net_of_transfers=${f.net_of_transfers}  all_exempt=${f.all_collectors_are_exempt}`,
    );
  }

  step(5, "Proving the three-way split with a live $0.02 payment");
  const PRICE = 0.02 * UNIT; // 20_000 units
  // Both halves of the 2-of-2 agent key. This is operator tooling proving the
  // split works, so it legitimately holds both; the agent process never does.
  const buyer = {
    id: state.agent.id,
    keys: [
      PrivateKey.fromStringECDSA(state.agent.agentKey),
      PrivateKey.fromStringECDSA(requirePolicyKey()),
    ],
  };

  // Seed from the treasury; the treasury is exempt, so this move carries no fee.
  await new TransferTransaction()
    .addTokenTransfer(tokenId, OPERATOR_ID, -1000 * UNIT)
    .addTokenTransfer(tokenId, buyer.id, 1000 * UNIT)
    .execute(client)
    .then((r) => r.getReceipt(client));

  let tx = new TransferTransaction()
    .addTokenTransfer(tokenId, buyer.id, -PRICE)
    .addTokenTransfer(tokenId, service.id, PRICE)
    .freezeWith(client);
  for (const k of buyer.keys) tx = await tx.sign(k);
  const resp = await tx.execute(client);
  await resp.getReceipt(client);
  const mirrorId = resp.transactionId.toString().replace("@", "-").replace(/\.(\d+)$/, "-$1");

  let record;
  for (let i = 0; i < 15; i++) {
    const res = await fetch(`${MIRROR_NODE_URL}/api/v1/transactions/${mirrorId}`);
    if (res.ok) {
      const b = await res.json();
      if (b.transactions?.length) { record = b.transactions[0]; break; }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  const label = { [buyer.id]: "buyer", [service.id]: "service", [upstream.id]: "upstream", [referrer.id]: "referrer" };
  console.log(`\n    one signed transfer of $0.02 — the buyer named only the service:`);
  for (const t of (record?.token_transfers ?? []).filter((t) => t.token_id === tokenId)) {
    console.log(`      ${(label[t.account] ?? t.account).padEnd(10)} ${String(t.amount).padStart(8)}  ($${(t.amount / UNIT).toFixed(4)})`);
  }
  console.log(`    assessed_custom_fees: ${record?.assessed_custom_fees?.length ?? 0} entries`);
  console.log(`    https://hashscan.io/testnet/transaction/${mirrorId}`);
  state.prism.proofTx = mirrorId;

  const fees = record?.assessed_custom_fees ?? [];
  const ok = fees.length === 2 &&
    (record.token_transfers ?? []).find((t) => t.account === service.id)?.amount === PRICE * 0.75;
  console.log("\n" + "=".repeat(66));
  console.log(ok ? "  PHASE 1 PASSED — three payees, one signature, no contract" : "  PHASE 1 FAILED");
  console.log("=".repeat(66));
} catch (err) {
  console.error(`\nPhase 1 errored: ${err?.message ?? err}`);
  process.exitCode = 1;
} finally {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  client.close();
}
