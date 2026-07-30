/**
 * Mirror-node reads. Every function here uses only the free, public, unauthenticated
 * REST API — no key, no account, no cooperation from us. That is deliberate: the
 * split has to be checkable by someone who does not trust the operator.
 */
const BASE = process.env.MIRROR_NODE_URL ?? "https://testnet.mirrornode.hedera.com";

/**
 * Every read retries. The mirror node is a shared public service — a transient 5xx
 * or a dropped connection is normal operating weather, not a signal about the data.
 * A 404 is different: it means "this does not exist", so it fails immediately rather
 * than spending four seconds confirming the same answer.
 */
async function get(path, { attempts = 3, delayMs = 400 } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${BASE}${path}`);
      if (res.ok) return res.json();
      if (res.status === 404) throw new Error(`mirror 404 for ${path}`);
      last = new Error(`mirror ${res.status} for ${path}`);
    } catch (err) {
      if (String(err.message).includes("404")) throw err;
      last = err;
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs * 2 ** i));
  }
  throw last;
}

/** SDK renders `0.0.x@secs.nanos`; the mirror node wants `0.0.x-secs-nanos`. */
export const toMirrorTxId = (id) =>
  String(id).replace("@", "-").replace(/\.(\d+)$/, "-$1");

/**
 * Token config, optionally as of a past consensus timestamp.
 *
 * The `?timestamp=` parameter returns the token as it stood then, which is what
 * makes honest auditing of an old settlement possible: a fee schedule that changed
 * after the fact must not silently change the expected numbers.
 */
export const tokenInfo = (tokenId, timestamp) =>
  get(`/api/v1/tokens/${tokenId}${timestamp ? `?timestamp=${encodeURIComponent(timestamp)}` : ""}`);

export const accountInfo = (accountId) => get(`/api/v1/accounts/${accountId}`);

/**
 * Consensus finality is instant but the mirror node trails it by a beat, so an
 * early 404 means "not yet", never "failed".
 */
export async function transaction(mirrorTxId, { attempts = 15, delayMs = 1200 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      const body = await get(`/api/v1/transactions/${mirrorTxId}`);
      if (body.transactions?.length) return body.transactions[0];
    } catch {
      /* not indexed yet */
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

/**
 * The live split, read from the token itself rather than from our own config.
 * If someone updates the fee schedule, this reflects it on the next request —
 * the 402 we advertise can never drift from what the ledger will actually do.
 */
export async function readSplit(tokenId, timestamp) {
  const info = await tokenInfo(tokenId, timestamp);
  const fractional = info.custom_fees?.fractional_fees ?? [];
  const shares = fractional.map((f) => ({
    collector: f.collector_account_id,
    numerator: Number(f.amount.numerator),
    denominator: Number(f.amount.denominator),
    basisPoints: Math.round((Number(f.amount.numerator) / Number(f.amount.denominator)) * 10_000),
    netOfTransfers: f.net_of_transfers,
  }));
  const feeBps = shares.reduce((sum, s) => sum + s.basisPoints, 0);
  return {
    tokenId,
    asOf: timestamp ?? null,
    feeScheduleCreated: info.custom_fees?.created_timestamp ?? null,
    decimals: Number(info.decimals),
    symbol: info.symbol,
    feeScheduleKeyType: info.fee_schedule_key?._type ?? null,
    shares,
    payToBasisPoints: 10_000 - feeBps,
  };
}

export const hashscanTx = (mirrorTxId) =>
  `https://hashscan.io/testnet/transaction/${mirrorTxId}`;
