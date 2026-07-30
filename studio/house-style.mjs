/**
 * The standing direction handed to the agent on every compose turn.
 *
 * Quality here is not agent taste, it is prompt structure. HyperFrames' own
 * guide is explicit that the difference between a finished video and a slideshow
 * is a set of clauses that must be *stated* rather than hoped for: an unnamed
 * spectacle beat gets dropped, an unstated hold renders as a frozen frame, and
 * an agent that is not routed through the skill guesses at HTML video
 * conventions instead of loading the framework's rules.
 *
 * So this file is deterministic. The agent chooses the story; it does not get to
 * choose whether the camera moves or whether the last second is alive.
 */

/** Facts about our pipeline that contradict the skills' defaults. */
function assetContract({ assets, narrationSeconds }) {
  const lines = assets.map(
    (a) => `  ${a.path}   ${a.role}${a.seconds ? `  (${a.seconds.toFixed(2)}s)` : ""}`,
  );
  return `
## The assets are already bought. Do not generate any.

Every asset below was purchased over x402 and is on disk. Reference each one by
its exact path. The skills will otherwise reach for their own TTS (Kokoro), their
own BGM catalogue, or image generation, and every one of those would be a second
copy of something the buyer has already paid for.

${lines.join("\n")}

Hard rules for this job:
  - Do NOT run \`hyperframes tts\`. The narration is bought and final.
  - Do NOT resolve BGM from the catalogue. The music bed is bought and final.
  - Do NOT generate images. Every visual asset you need is listed above.
  - If you believe an asset is missing, stop and say so. Do not substitute.

The narration is ${narrationSeconds.toFixed(2)} seconds long, measured from the
file rather than estimated. Time the composition to it exactly. This is the one
place the usual "~60 seconds" advice does not apply: the spoken length is a known
quantity here, not a guess.
`.trim();
}

/**
 * The eight motion rules, compressed to the clauses that change output.
 *
 * Stated as requirements rather than suggestions because the failure mode is
 * silent: a composition that violates every one of these still renders, still
 * passes lint, and still looks like a slideshow.
 */
const MOTION = `
## Motion grammar, non-negotiable

1. Nothing ever fully stops. Every hold carries an ambient idle: a 1-2% breathing
   scale, a slow drift. Never write "holds motionless". A frozen final second is
   the single biggest cheap-motion tell, and it is the first thing I will check.
2. The camera acts. Each scene gets one continuous move, a 4-8% push-in, a slow
   pan, parallax between planes, easing gently and never decaying to a dead stop.
3. Overlapping action. No two elements share a start time. Stagger supporting
   elements at offsets clearly shorter than the animation they offset. Never delay
   the focal element; a focal element that waits reads as lag. Stagger what is
   *arriving*, not what was already there.
4. Compound properties only when they tell one story. Slide plus fade both say
   "arriving" and belong together. Rise plus rotate are two unrelated claims.
5. Overshoot on transforms only. A number must never fly past its value and fall
   back: that renders a figure that was never true.
6. Three depth planes with parallax, and one large blurred foreground element
   that actually crosses in front of the content. Occlusion sells depth; blur
   alone does not.
7. Pace to genre. 1.5-4 seconds per idea. A stretched idea feels slow no matter
   how well it is animated.
8. Any randomness is seeded, and any stop-motion hold is quantized on the integer
   frame index, never on elapsed seconds.
`.trim();

/** The two properties that stop a multi-scene piece reading as slides. */
const CONTINUITY = `
## This must not read as a slideshow

A run of well-animated scenes that happen to play in order is the most common
failure on multi-scene work, and more animation does not fix it. Two properties
do, and both must be present:

  1. Something crosses every boundary. A shared element, a shared space, or a
     motion vector the eye follows through the transition. Name what it is.
     Pick one device and hold it for the whole piece: a persistent element that
     never leaves frame, a match cut on a shared shape, a hero prop, a frame or
     HUD that survives the cut, or accumulation onto one canvas.
  2. The energy varies. Emphasis is a contrast effect, so the piece needs quiet
     for a hero moment to register against. Uniform motion is as flat as none.

Name one spectacle beat: a single exaggerated moment, placed where the piece
earns it, everything around it restrained. State it explicitly. An unnamed
spectacle beat gets dropped.

Forbidden outright: any scene that fades in centred, sits, and fades out.
`.trim();

/** Determinism, stated because a violation renders wrong rather than erroring. */
const DETERMINISM = `
## Determinism

  - Register every timeline on window.__timelines. The renderer cannot seek what
    it does not know about.
  - No Math.random(), no Date.now(), no wall clock, no fetch during timeline
    construction. Seek must be reproducible.
  - Timed sections need class="clip" plus data-start, data-duration and
    data-track-index. Two clips on one track index must not overlap in time.
  - Video elements render muted; their audio rides a sibling <audio> element.
  - A fromTo back-renders its from-state at every earlier time, so an element
    that must be absent before its cue needs a to() plus keyframes, or a
    zero-duration set at the beat boundary.
`.trim();

/**
 * The gate, in the order that costs least.
 *
 * check runs the composition in a headless browser and names overflow, text
 * collisions, mid-timeline runtime errors and contrast failures in seconds. It
 * is strictly cheaper than rendering and then looking, so it runs first, and a
 * render is not attempted until it passes.
 */
const GATE = `
## The gate

Run, in this order, and do not skip:

    HYPERFRAMES_SKIP_SKILLS=1 npx hyperframes lint
    HYPERFRAMES_SKIP_SKILLS=1 npx hyperframes check

check loads the composition in a headless browser and reports what a still frame
cannot: an element overflowing its region, two text blocks colliding, a runtime
error that only fires mid-timeline, contrast below WCAG AA. Both must pass before
you render. A render that takes minutes will happily contain a defect check would
have named in seconds.

Only when both pass, render.
`.trim();

/**
 * Compose the full directive for one job.
 *
 * @param {object} job
 * @param {string} job.brief          what the buyer asked for
 * @param {Array}  job.assets         bought assets: {path, role, seconds?}
 * @param {number} job.narrationSeconds
 * @param {string} [job.aspect]       defaults to 1920x1080
 */
export function houseStyle(job) {
  return [
    `# Direction for this job`,
    ``,
    `Route this through the \`/general-video\` workflow. Do not use`,
    `\`/faceless-explainer\`: it generates its own narration, and ours is bought.`,
    ``,
    `**Brief.** ${job.brief}`,
    ``,
    `**Spec.** ${job.aspect ?? "1920x1080"}, 30fps, ${job.narrationSeconds.toFixed(2)}s,`,
    `timed to the narration file.`,
    ``,
    assetContract(job),
    ``,
    MOTION,
    ``,
    CONTINUITY,
    ``,
    DETERMINISM,
    ``,
    GATE,
    ``,
    `## Deliverables`,
    ``,
    `Write STORYBOARD.md and SCRIPT.md before you write any HTML, following the`,
    `beat formula: element, motion, layout, style, timing, one sentence per`,
    `element, with real timestamps taken from the narration. Quote all on-screen`,
    `copy exactly; unquoted copy gets paraphrased. Name any registry block you`,
    `intend to adapt.`,
  ].join("\n");
}

export { MOTION, CONTINUITY, DETERMINISM, GATE };
