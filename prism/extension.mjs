/**
 * The `prism` x402 extension — disclosure for consensus-assessed revenue splits.
 *
 * Prism's mechanism works precisely because the split is invisible to the signed
 * transaction body: HTS custom fees are merged in at consensus, so a facilitator
 * decompiling the payload sees one clean payment to `payTo` and Rule 5 is satisfied
 * exactly as written. That is good for compliance and bad for trust — a buyer
 * should not discover after the fact that its payment was divided.
 *
 * This extension closes that gap without touching the mechanism:
 *
 *   402 response  → declare who gets what, read live from the token's own fee
 *                   schedule. The buyer consents by paying.
 *   PAYMENT-RESPONSE → return the fees the network actually assessed, plus a
 *                   HashScan link, so the buyer can check the promise was kept.
 *
 * Neither hook alters the transfer. The 402 numbers come from the ledger rather
 * than from our config, so what we advertise cannot drift from what happens.
 */
import { readSplit, transaction, toMirrorTxId, hashscanTx } from "./mirror.mjs";

const CACHE_MS = 15_000;
let cache = { at: 0, value: null, tokenId: null };

async function cachedSplit(tokenId) {
  const now = Date.now();
  if (cache.tokenId === tokenId && cache.value && now - cache.at < CACHE_MS) return cache.value;
  const value = await readSplit(tokenId);
  cache = { at: now, value, tokenId };
  return value;
}

/**
 * @param {object} opts
 * @param {string} opts.tokenId  the fee-bearing asset whose schedule defines the split
 * @param {Record<string,string>} [opts.labels]  collector account id → human role
 */
export function prismExtension({ tokenId, labels = {} }) {
  return {
    key: "prism",

    // The assessed amounts and tx id differ every call, so they must not be
    // subject to the client-echo equality check.
    dynamicInfoFields: ["quotedAt"],

    async enrichPaymentRequiredResponse(_declaration, _context) {
      const split = await cachedSplit(tokenId);
      return {
        info: {
          version: 1,
          mechanism: "hts-fractional-custom-fee",
          settlement: "atomic-at-consensus",
          // Stated plainly: the payer is debited the quoted amount and no more.
          payerDebit: "exactly the quoted amount",
          asset: split.tokenId,
          decimals: split.decimals,
          // Governance matters as much as the numbers — a split the operator can
          // rewrite alone is not really enforced.
          feeScheduleGovernedBy: split.feeScheduleKeyType,
          payees: [
            {
              role: "service",
              basisPoints: split.payToBasisPoints,
              via: "payTo",
            },
            ...split.shares.map((s) => ({
              role: labels[s.collector] ?? "collector",
              account: s.collector,
              basisPoints: s.basisPoints,
              via: "assessed_custom_fee",
            })),
          ],
          verify: "GET /v1/audit/{transactionId} — recomputes from public mirror-node data",
          quotedAt: new Date().toISOString(),
        },
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            version: { type: "number" },
            mechanism: { type: "string" },
            asset: { type: "string" },
            payees: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  role: { type: "string" },
                  account: { type: "string" },
                  basisPoints: { type: "number" },
                  via: { type: "string", enum: ["payTo", "assessed_custom_fee"] },
                },
                required: ["role", "basisPoints", "via"],
              },
            },
          },
          required: ["version", "mechanism", "asset", "payees"],
        },
      };
    },

    async enrichSettlementResponse(_declaration, context) {
      // SettleResultContext exposes the facilitator outcome as `result`.
      const txId = context?.result?.transaction;
      if (!txId) return {};
      const mirrorId = toMirrorTxId(txId);
      // Short poll only: the buyer is waiting on this response, and an unconfirmed
      // read is better than a slow one. The audit endpoint is the durable answer.
      const record = await transaction(mirrorId, { attempts: 4, delayMs: 700 });
      const assessed = record?.assessed_custom_fees ?? [];
      return {
        transactionId: mirrorId,
        hashscan: hashscanTx(mirrorId),
        refracted: assessed.map((f) => ({
          role: labels[f.collector_account_id] ?? "collector",
          account: f.collector_account_id,
          amount: String(f.amount),
        })),
        // Absence here is a mirror-node lag artifact, not evidence of no split.
        indexed: Boolean(record),
        audit: `/v1/audit/${mirrorId}`,
      };
    },
  };
}
