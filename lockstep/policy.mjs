/**
 * The policy co-signer — spending guardrails enforced by the ledger.
 *
 * The agent's account is a Hedera KeyList with threshold 2. The agent holds one
 * key; this service holds the other. A payment needs both signatures, so the
 * agent cannot overspend even if it is compromised, jailbroken, or hallucinating:
 * the key material it possesses is simply insufficient.
 *
 * That is the difference from every application-layer guardrail. A spend limit
 * checked by the agent's own code, or by a row in the operator's database, is a
 * policy the agent's process could skip. This one is arithmetic on signatures,
 * evaluated by consensus nodes.
 *
 * Everything below the signature is ordinary policy: caps, allowlists, rate
 * limits. The point is not that the rules are clever — it is *where they are
 * enforced*.
 */
import { readFileSync } from "node:fs";
import { PrivateKey, Transaction, TransferTransaction } from "@hiero-ledger/sdk";

/**
 * Reject any transaction component this policy does not explicitly understand.
 *
 * A `TransferTransaction` is not just one map. It can carry HBAR transfers, fungible
 * token transfers, **NFT transfers**, and per-entry `isApproved` allowance flags —
 * all in the same signed body. Validating only the two maps a payment normally uses
 * leaves the rest as smuggling space: a correct-looking fungible payment with an NFT
 * quietly riding along drains a different asset entirely, and both the fungible
 * checks and the facilitator's own inspector look straight past it.
 *
 * So this is a whitelist, not a blacklist. Anything outside "plain transfers of the
 * one expected asset" is refused, including shapes that do not exist yet — a policy
 * that enumerates known attacks is obsolete the moment the SDK grows a field.
 *
 * @returns {string|null} a refusal reason, or null if the shape is acceptable
 */
function rejectUnexpectedShape(tx) {
  if ((tx.nftTransfers?.size ?? 0) > 0) {
    return "transaction carries NFT transfers alongside the payment";
  }
  const flagged = [...(tx._hbarTransfers ?? []), ...(tx._tokenTransfers ?? [])].some(
    (entry) => entry?.isApproved || entry?.hookCall,
  );
  if (flagged) {
    return "transaction uses allowance-delegated or hook-bearing transfers";
  }
  // Token transfer groups nest their own entries; check those too.
  for (const group of tx._tokenTransfers ?? []) {
    const nested = [...(group?.transfers ?? []), ...(group?.nftTransfers ?? [])];
    if (nested.some((e) => e?.isApproved || e?.hookCall)) {
      return "transaction uses allowance-delegated or hook-bearing token transfers";
    }
    if ((group?.nftTransfers?.length ?? 0) > 0) {
      return "transaction carries NFT transfers alongside the payment";
    }
  }
  return null;
}

/**
 * Flatten a transfer transaction into [accountId, signedAmount] pairs for one asset.
 *
 * Returns null if the transaction touches any asset other than the expected one —
 * a payment that also moves something else is not a payment we will co-sign.
 * For token payments this also rejects stray HBAR movement, mirroring the rule the
 * facilitator enforces.
 */
function extractTransfers(tx, asset) {
  const out = [];
  if (asset === "0.0.0") {
    if ((tx.tokenTransfers?.size ?? 0) > 0) return null;
    for (const [account, hbar] of tx.hbarTransfers ?? []) {
      out.push([account.toString(), BigInt(hbar.toTinybars().toString())]);
    }
    return out;
  }
  if ((tx.hbarTransfers?.size ?? 0) > 0) return null;
  for (const [tokenId, perAccount] of tx.tokenTransfers ?? []) {
    if (tokenId.toString() !== asset) return null;
    for (const [account, amount] of perAccount ?? []) {
      out.push([account.toString(), BigInt(amount.toString())]);
    }
  }
  return out;
}

const state = JSON.parse(readFileSync(new URL("../.state.json", import.meta.url), "utf8"));

// The co-signer key lives in its own 0600 file, not in .state.json, and only this
// module reads it. That separation is the point: if the second key sat in the same
// file the agent loads, the threshold account would have the right *shape* on-chain
// while the compromise boundary it implies did not exist. The agent process must
// have no path to this material — it talks to the policy server over HTTP.
const policyKey = PrivateKey.fromStringECDSA(
  readFileSync(new URL("../.policy.key", import.meta.url), "utf8").trim(),
);

export const POLICY = {
  // Denominated in the smallest unit of each asset.
  maxPerCall: { [state.lockstep.tokenId]: 50_000n, "0.0.0": 1_000_000n },
  // Only these accounts may be paid, whatever a 402 claims.
  allowedPayees: new Set([state.lockstep.service.id]),
  allowedAssets: new Set([state.lockstep.tokenId, "0.0.0"]),
  maxCallsPerMinute: 30,
};

const recent = [];

/**
 * Evaluate a payment and, if it passes, add the second signature.
 *
 * Returns the fully-signed transaction on approval. On refusal it returns no
 * signature at all — there is nothing the caller can do to proceed.
 */
export async function requestCosign({ transactionBase64, challenge }) {
  const refuse = (reason) => ({ approved: false, reason });

  if (!POLICY.allowedAssets.has(challenge.asset)) {
    return refuse(`asset ${challenge.asset} is not on the allowlist`);
  }
  if (!POLICY.allowedPayees.has(challenge.payTo)) {
    return refuse(`payee ${challenge.payTo} is not on the allowlist`);
  }

  const amount = BigInt(challenge.amount);
  const cap = POLICY.maxPerCall[challenge.asset];
  if (cap !== undefined && amount > cap) {
    return refuse(`amount ${amount} exceeds the per-call cap of ${cap} for ${challenge.asset}`);
  }

  const now = Date.now();
  while (recent.length && now - recent[0] > 60_000) recent.shift();
  if (recent.length >= POLICY.maxCallsPerMinute) {
    return refuse(`rate limit: ${POLICY.maxCallsPerMinute} calls/minute already used`);
  }

  // Everything above is a claim the caller made. From here on, decide only against
  // the bytes that will actually be submitted.
  //
  // This matters more than it looks: the whole reason the co-signer exists is a
  // compromised agent, and a compromised agent controls the summary it hands us.
  // It could present a benign challenge naming the allowlisted service while the
  // transaction redirects the money somewhere else. So the challenge is used only
  // to look up the cap; the payee, the amount and the asset are all re-derived.
  let tx;
  try {
    tx = Transaction.fromBytes(Buffer.from(transactionBase64, "base64"));
  } catch {
    return refuse("payload is not a decodable Hedera transaction");
  }
  if (!(tx instanceof TransferTransaction)) {
    return refuse(`expected a TransferTransaction, got ${tx.constructor?.name}`);
  }

  // Shape first, arithmetic second. A transaction can be numerically perfect on the
  // asset we checked while moving something else entirely.
  const badShape = rejectUnexpectedShape(tx);
  if (badShape) return refuse(badShape);

  const entries = extractTransfers(tx, challenge.asset);
  if (entries === null) {
    return refuse(`transaction moves an asset other than ${challenge.asset}`);
  }
  if (entries.reduce((s, [, v]) => s + v, 0n) !== 0n) {
    return refuse("transfers do not sum to zero");
  }

  const credits = entries.filter(([, v]) => v > 0n);
  if (credits.length !== 1) {
    return refuse(`expected exactly one recipient, transaction credits ${credits.length}`);
  }
  const [recipient, credited] = credits[0];
  if (!POLICY.allowedPayees.has(recipient)) {
    return refuse(`transaction actually pays ${recipient}, which is not on the allowlist`);
  }
  if (recipient !== challenge.payTo) {
    return refuse(`transaction pays ${recipient} but the challenge named ${challenge.payTo}`);
  }
  if (credited !== amount) {
    return refuse(`transaction credits ${credited} but the challenge quoted ${amount}`);
  }

  const debited = -entries.filter(([, v]) => v < 0n).reduce((s, [, v]) => s + v, 0n);
  if (debited !== amount) {
    return refuse(`transaction debits ${debited} but the challenge quoted ${amount}`);
  }

  recent.push(now);
  const cosigned = await tx.sign(policyKey);
  return {
    approved: true,
    reason: `within cap (${amount} ≤ ${cap}), payee and asset allowlisted`,
    transactionBase64: Buffer.from(cosigned.toBytes()).toString("base64"),
  };
}
