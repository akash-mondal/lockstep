/**
 * What a job costs us, and what it costs the buyer.
 *
 * The split is fixed on the token forever while the asset bill varies per job,
 * and those two facts only coexist if the quote is derived from the job's own
 * cost. With upstream share `s` and a quote of `cost x m`, the upstream share is
 * solvent exactly when `s*m >= 1`. At 35% and 3.7x that leaves 30% headroom on
 * every job size, which absorbs the music model's 2x duration variance and the
 * vision calls in the review loop. A flat price would be solvent on a short job
 * and underwater on a long one.
 */

/** Foundry list prices, in tinybar. The studio pays these, per call, in HBAR. */
export const SKU = {
  image: 25_000_000n,
  speech: 5_000_000n,
  music: 50_000_000n,
  transcribe: 10_000_000n,
};

/** The share of a sale that reaches the upstream collector. */
export const UPSTREAM_SHARE = 0.35;

/**
 * Multiplier from cost to quote.
 *
 * 2.86 is break-even for a 35% share. 3.7 is that plus a margin wide enough
 * that one surprise (a longer music clip, an extra review pass) does not put
 * the share underwater on a job already sold.
 */
export const MULTIPLIER = 3.7;

/** Nobody sells a video for less than this, however small the plan. */
export const FLOOR = 300_000_000n; // 3 PRISM

/**
 * Price a plan.
 *
 * Counts every purchase the plan implies rather than guessing from scene count,
 * because narration is per line and a plan may skip music entirely.
 *
 * @param {object} plan
 * @param {Array}  plan.scenes       each scene that needs an image
 * @param {Array}  [plan.narration]  one entry per line to speak
 * @param {boolean}[plan.music]      whether a bed is wanted
 * @param {boolean}[plan.captions]   captions need a transcription
 */
export function priceJob(plan) {
  const images = (plan.scenes ?? []).filter((s) => s.image !== false).length;
  const lines = (plan.narration ?? []).length;
  const music = plan.music === false ? 0 : 1;
  const transcribe = plan.captions === false ? 0 : (lines > 0 ? 1 : 0);

  const items = [
    { sku: "image", count: images, each: SKU.image },
    { sku: "speech", count: lines, each: SKU.speech },
    { sku: "music", count: music, each: SKU.music },
    { sku: "transcribe", count: transcribe, each: SKU.transcribe },
  ].filter((i) => i.count > 0);

  const cost = items.reduce((sum, i) => sum + i.each * BigInt(i.count), 0n);

  // BigInt has no fractions, so the multiplier is applied in basis points.
  const quoted = (cost * BigInt(Math.round(MULTIPLIER * 10_000))) / 10_000n;
  const quote = quoted > FLOOR ? quoted : FLOOR;

  const upstream = (quote * 35n) / 100n;
  const quoteUnits = quote / 100n; // PRISM has 6 decimals; cost is in tinybar
  return {
    items: items.map((i) => ({ ...i, each: String(i.each), subtotal: String(i.each * BigInt(i.count)) })),
    costTinybar: String(cost),
    quoteTinybar: String(quote),
    // What the buyer is actually charged, in the token's own units.
    quoteUnits: String(quoteUnits),
    // Stated so a buyer can see the margin rather than infer it.
    breakdown: {
      studio: String((quoteUnits * 50n) / 100n),
      upstream: String((quoteUnits * 35n) / 100n),
      referrer: String((quoteUnits * 15n) / 100n),
    },
    // The number that matters operationally: can the share cover the bill.
    upstreamCoversCost: upstream >= cost,
    headroomPct: cost === 0n ? null : Number(((upstream - cost) * 100n) / cost),
  };
}

/** A spend ceiling for the job, so a looping agent cannot outrun its budget. */
export function budgetFor(quotePlan) {
  // The agent may buy at most what the plan implies, plus one retry of the most
  // expensive single item. Anything beyond that is a loop, not a job.
  const cost = BigInt(quotePlan.costTinybar);
  return String(cost + SKU.music);
}

export const hbar = (tinybar) => Number(BigInt(tinybar)) / 1e8;

/**
 * Costs are reckoned in tinybar because that is what the foundry charges in.
 * PRISM carries six decimals, not eight, so a quote crossing from one to the
 * other is divided by 100. Skipping that step prices a 6.66 video at 666 and
 * the only symptom is a payment nobody can afford.
 */
export const TINYBAR_PER_PRISM_UNIT = 100n;
export const toStudUnits = (tinybar) => String(BigInt(tinybar) / TINYBAR_PER_PRISM_UNIT);
export const stud = (units) => Number(BigInt(units)) / 1e6;
