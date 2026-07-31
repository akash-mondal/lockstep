/**
 * What a job costs us, and what it costs the buyer.
 *
 * Settlement is native HBAR, so there is no fee schedule to satisfy and the
 * quote is simply the job's own measured cost plus a margin. That margin is the
 * making charge: the studio's fee for planning, composing, rendering and
 * reviewing, and it is reported afterwards rather than buried, because a quote
 * with margin in it is only honest if the margin is visible.
 *
 * Pricing from the job's own cost rather than a flat rate matters as much here
 * as it did before: a twelve-scene video buys twelve images, and a flat price
 * would be generous on a short job and underwater on a long one.
 */

/** Foundry list prices, in tinybar. The studio pays these, per call, in HBAR. */
export const SKU = {
  image: 25_000_000n,
  speech: 5_000_000n,
  music: 50_000_000n,
  transcribe: 10_000_000n,
  vision: 8_000_000n,
};

/**
 * How many times the studio looks at its own work and pays to do so.
 *
 * Each design pass is a vision call against snapshots, plus a final look at the
 * render. This is priced in rather than absorbed because looking is not
 * incidental: it is the difference between shipping a first attempt and shipping
 * something revised, and a budget that does not cover it quietly stops the loop
 * partway through.
 */
export const LOOKS = 4;

/** How much of a quote is margin rather than cost, at the default multiplier. */
export const MARGIN_NOTE = "quote = measured cost x MULTIPLIER; the remainder is the making charge";

/**
 * Multiplier from cost to quote.
 *
 * Wide enough that one surprise, a longer music clip or an extra review pass,
 * is absorbed rather than eating the whole margin on a job already sold. x402
 * `exact` has no refund path, so a quote that turns out to be short cannot be
 * corrected after the fact.
 */
export const MULTIPLIER = 3.0;

/** Nobody sells a video for less than this, however small the plan. */
export const FLOOR = 300_000_000n; // 3 LOCKSTEP

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

  return {
    items: items.map((i) => ({ ...i, each: String(i.each), subtotal: String(i.each * BigInt(i.count)) })),
    costTinybar: String(cost),
    quoteTinybar: String(quote),
    // Stated up front so a buyer sees the margin rather than inferring it.
    marginTinybar: String(quote - cost),
    marginPct: cost === 0n ? null : Number(((quote - cost) * 100n) / cost),
  };
}

/** A spend ceiling for the job, so a looping agent cannot outrun its budget. */
export function budgetFor(quotePlan) {
  // The agent may buy at most what the plan implies, plus every look the design
  // loop is allowed, plus one retry of the most expensive single item. Anything
  // beyond that is a loop, not a job.
  const cost = BigInt(quotePlan.costTinybar);
  return String(cost + SKU.vision * BigInt(LOOKS) + SKU.music);
}

export const hbar = (tinybar) => Number(BigInt(tinybar)) / 1e8;

