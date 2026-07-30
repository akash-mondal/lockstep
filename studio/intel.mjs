/**
 * The metered service: what an agent is actually buying.
 *
 * Prism sells counterparty intelligence to agents that are about to pay someone.
 * The two questions an autonomous payer cannot answer from a price quote alone:
 *
 *   "What will this HTS token actually cost me to send?"  — an x402 `exact` quote
 *   names an amount, but on Hedera the asset itself can carry custom fees, so the
 *   recipient may land less than the quote, or the sender may be debited more.
 *   An agent that does not check this is trusting the seller's arithmetic.
 *
 *   "Is this account safe to pay?" — age, activity, whether it can even receive
 *   the asset. Paying an unassociated account fails at consensus after verify
 *   has already passed.
 *
 * Both are answered from public mirror-node data, so the service is honest about
 * being a convenience layer rather than privileged information — and it is the
 * exact tool that would disclose Prism's own split to a stranger.
 */
import { accountInfo, tokenInfo } from "../prism/mirror.mjs";

/** What a transfer of this token really costs, beyond the quoted amount. */
export async function tokenCost(tokenId, amountRaw) {
  const info = await tokenInfo(tokenId);
  const decimals = Number(info.decimals);
  const fractional = info.custom_fees?.fractional_fees ?? [];
  const fixed = info.custom_fees?.fixed_fees ?? [];
  const amount = amountRaw ? BigInt(amountRaw) : null;

  const fractionalDetail = fractional.map((f) => {
    const num = BigInt(f.amount.numerator);
    const den = BigInt(f.amount.denominator);
    return {
      collector: f.collector_account_id,
      fraction: `${f.amount.numerator}/${f.amount.denominator}`,
      basisPoints: Number((num * 10_000n) / den),
      // Who actually bears it is the part agents get wrong.
      borneBy: f.net_of_transfers ? "sender (charged on top)" : "receiver (deducted from credit)",
      amountOnQuote: amount === null ? null : String((amount * num) / den),
    };
  });

  const totalBps = fractionalDetail.reduce((s, f) => s + f.basisPoints, 0);
  const feeTotal = amount === null ? null : fractionalDetail.reduce((s, f) => s + BigInt(f.amountOnQuote), 0n);

  return {
    tokenId,
    symbol: info.symbol,
    name: info.name,
    decimals,
    type: info.type,
    // A token with no fee schedule key can never acquire custom fees — that is a
    // permanent guarantee, not a current state, and worth surfacing as such.
    feeScheduleKey: info.fee_schedule_key ? info.fee_schedule_key._type : null,
    canEverHaveCustomFees: Boolean(info.fee_schedule_key),
    pausable: Boolean(info.pause_key),
    freezable: Boolean(info.freeze_key),
    hasCustomFees: fractional.length + fixed.length > 0,
    fractionalFees: fractionalDetail,
    fixedFees: fixed.map((f) => ({
      collector: f.collector_account_id,
      amount: String(f.amount),
      denominatingToken: f.denominating_token_id ?? "HBAR",
    })),
    quote:
      amount === null
        ? null
        : {
            quoted: String(amount),
            totalFeeBasisPoints: totalBps,
            feesAssessed: String(feeTotal),
            receiverLands: String(amount - feeTotal),
            senderDebited: String(amount),
          },
    verdict:
      fractional.length + fixed.length === 0
        ? "clean — the recipient lands exactly the quoted amount"
        : `${totalBps} bps routed to ${fractional.length + fixed.length} custom fee collector(s)`,
  };
}

/** Whether an account is safe and able to be paid. */
export async function accountRisk(accountId, assetId) {
  const info = await accountInfo(accountId);
  const flags = [];

  if (info.deleted) flags.push({ level: "critical", note: "account is deleted" });
  if (Number(info.balance?.balance ?? 0) === 0) {
    flags.push({ level: "info", note: "holds no HBAR — normal for a fee-sponsored agent" });
  }

  let canReceive = null;
  if (assetId) {
    const tokens = info.balance?.tokens ?? [];
    const associated = tokens.some((t) => t.token_id === assetId);
    const slots = info.max_automatic_token_associations;
    canReceive = associated || slots === -1 || (slots ?? 0) > tokens.length;
    if (!canReceive) {
      flags.push({
        level: "critical",
        // This is the failure that passes /verify and dies at settlement.
        note: `not associated with ${assetId} and no auto-association slots — settlement would fail with TOKEN_NOT_ASSOCIATED_TO_ACCOUNT`,
      });
    }
  }

  const keyType = info.key?._type ?? null;
  if (keyType === "ProtobufEncoded") {
    flags.push({ level: "info", note: "multi-key account (KeyList or ThresholdKey) — spending requires more than one signature" });
  }

  return {
    accountId: info.account,
    evmAddress: info.evm_address,
    createdAt: info.created_timestamp,
    hbarBalance: String(info.balance?.balance ?? 0),
    keyType,
    autoAssociationSlots: info.max_automatic_token_associations,
    canReceive,
    flags,
    verdict: flags.some((f) => f.level === "critical") ? "do-not-pay" : "ok-to-pay",
  };
}
