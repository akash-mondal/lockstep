/**
 * Keyless audit: recompute a Lockstep settlement from public data alone.
 *
 * The point is that nobody has to take our word for it. This endpoint holds no
 * secret and reads nothing we control — it fetches the token's fee schedule and
 * the transaction record from the public mirror node, recomputes what each payee
 * *should* have received, and compares that against what the ledger actually
 * moved. Anyone can run the same two HTTP GETs and check our arithmetic.
 *
 * A mismatch is provable misconduct rather than a disagreement.
 */
import { readSplit, tokenInfo, transaction, hashscanTx } from "./mirror.mjs";

/**
 * @param {string} mirrorTxId
 * @param {object} opts
 * @param {string} opts.tokenId   the asset a Lockstep payment must settle in
 * @param {string} [opts.payTo]   the service account a Lockstep payment must credit
 * @param {Record<string,string>} [opts.labels]
 */
export async function auditSettlement(mirrorTxId, { tokenId, payTo, labels = {} } = {}) {
  const record = await transaction(mirrorTxId, { attempts: 6, delayMs: 1000 });
  if (!record) {
    return { ok: false, reason: "not_indexed", transactionId: mirrorTxId, hashscan: hashscanTx(mirrorTxId) };
  }

  const transfers = (record.token_transfers ?? []).filter((t) => !tokenId || t.token_id === tokenId);
  if (!transfers.length) {
    return { ok: false, reason: "no_token_transfers", transactionId: mirrorTxId, hashscan: hashscanTx(mirrorTxId) };
  }

  const asset = tokenId ?? transfers[0].token_id;
  // The fee schedule *as of this transaction*, not as of now. Comparing an old
  // settlement against today's schedule would score it against rules that did not
  // exist when it settled — and would let a later TokenFeeScheduleUpdate rewrite
  // history's expected numbers.
  const at = record.consensus_timestamp;
  const [split, info] = await Promise.all([readSplit(asset, at), tokenInfo(asset, at)]);
  const assessed = (record.assessed_custom_fees ?? []).filter((f) => f.token_id === asset);

  // The gross payment is what the payer was debited — the signed amount, before
  // consensus split it. Everything else is derived from that single number, so it
  // sums *every* debit rather than the first: a transaction with two senders would
  // otherwise be scored against a fraction of what actually moved, and every
  // downstream share check would be quietly wrong.
  const debits = transfers.filter((t) => BigInt(t.amount) < 0n);
  const gross = -debits.reduce((s, t) => s + BigInt(t.amount), 0n);
  const singleSender = debits.length === 1;

  const checks = [];
  for (const share of split.shares) {
    const expected = (gross * BigInt(share.numerator)) / BigInt(share.denominator);
    const actualFee = assessed
      .filter((f) => f.collector_account_id === share.collector)
      .reduce((s, f) => s + BigInt(f.amount), 0n);
    checks.push({
      role: labels[share.collector] ?? "collector",
      account: share.collector,
      fraction: `${share.numerator}/${share.denominator}`,
      expected: String(expected),
      actual: String(actualFee),
      matches: expected === actualFee,
    });
  }

  const feesTotal = checks.reduce((s, c) => s + BigInt(c.actual), 0n);
  const credits = transfers.filter((t) => BigInt(t.amount) > 0n);
  const collectorIds = new Set(split.shares.map((s) => s.collector));
  const nonCollectorCredits = credits.filter((t) => !collectorIds.has(t.account));
  const payToCredit = nonCollectorCredits.reduce((s, t) => s + BigInt(t.amount), 0n);
  const expectedPayTo = gross - feesTotal;

  // Identity, not just arithmetic. Without these, this endpoint would happily
  // "verify" any transfer of any token that happens to balance — including one
  // that never touched Lockstep, or that paid somebody else entirely. Arithmetic
  // conservation is necessary but nowhere near sufficient.
  const isExpectedAsset = !tokenId || asset === tokenId;
  const paidTheService = !payTo || nonCollectorCredits.every((t) => t.account === payTo);
  const creditedTheService = !payTo || nonCollectorCredits.some((t) => t.account === payTo);
  const wasRefracted = assessed.length > 0;
  const singleRecipient = nonCollectorCredits.length === 1;

  // Conservation is the strongest single check: if debits and credits don't sum
  // to zero, something outside the fee schedule moved value.
  const netZero = transfers.reduce((s, t) => s + BigInt(t.amount), 0n) === 0n;
  const payToMatches = payToCredit === expectedPayTo;
  const allSharesMatch = checks.every((c) => c.matches);

  const identityOk =
    isExpectedAsset && paidTheService && creditedTheService && singleRecipient && singleSender && wasRefracted;

  return {
    ok: netZero && payToMatches && allSharesMatch && identityOk,
    isLockstepPayment: identityOk,
    transactionId: mirrorTxId,
    hashscan: hashscanTx(mirrorTxId),
    consensusTimestamp: record.consensus_timestamp,
    asset,
    symbol: info.symbol,
    decimals: split.decimals,
    grossPaid: String(gross),
    payees: [
      { role: "service", via: "payTo", expected: String(expectedPayTo), actual: String(payToCredit), matches: payToMatches },
      ...checks.map((c) => ({ ...c, via: "assessed_custom_fee" })),
    ],
    invariants: {
      transfersSumToZero: netZero,
      everyShareMatchesFeeSchedule: allSharesMatch,
      payToReceivedRemainder: payToMatches,
      settledInExpectedAsset: isExpectedAsset,
      creditedTheServiceAccount: creditedTheService,
      noUnexpectedRecipients: paidTheService && singleRecipient,
      singleSender,
      networkAssessedCustomFees: wasRefracted,
    },
    feeScheduleAsOf: at,
    method:
      "Recomputed from GET /api/v1/tokens/{asset}?timestamp={consensus} and GET /api/v1/transactions/{id} on the public mirror node. No credentials, no cooperation from the operator.",
    // What this check does and does not cover, stated so nobody mistakes its scope.
    scope:
      "Verifies the token movements of this transaction against the fee schedule in force at its consensus timestamp. It does not attest to off-chain custody arrangements, to who controls the collector accounts, or to whether the resource server returned correct data.",
  };
}
