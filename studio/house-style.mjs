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
  const transcript = assets.find((a) => /timing|transcript/i.test(a.role ?? ""))?.path ?? null;
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
${transcript ? `
The word timings in ${transcript} are the caption track. Each entry carries a
word and the time it is spoken. Read the file, group the words into phrases, and
drive the captions off those numbers. They were bought for this job; rendering
without them wastes an asset the buyer paid for.` : ""}
`.trim();
}

/**
 * What is already known, so the turn is spent composing rather than surveying.
 *
 * A timed compose turn spent 13 of its first 18 minutes finding out things that
 * are identical on every job: three minutes grepping the skill tree for which
 * fonts exist, four minutes probing asset durations, then reading five JPEGs it
 * had already been given a written storyboard for. Measuring all of it takes
 * well under a second, so it is measured before the turn starts and stated here
 * as fact. What is stated as fact must not be re-derived.
 */
function known({ media, fonts, narrationSeconds }) {
  return `
## Measured facts. Do not go looking for these again.

Every number here was measured on this machine, for these files, moments ago.
Re-deriving any of it is the single most expensive mistake available in this
turn, and it produces the same answer.

### The files, with their real durations and dimensions
${media.join("\n")}

Narration runs ${narrationSeconds.toFixed(2)} seconds. That is the length of the
piece. Do not probe these files. Do not run ffprobe, ffmpeg, sox, or a shell loop
over the assets. Do not open the images to see what is in them: the storyboard
already describes every scene, and a JPEG costs more to look at than to place.

### Fonts installed on this machine
${fonts.length ? fonts.map((f) => `  ${f}`).join("\n") : "  none reported"}

That list is exhaustive. Anything else silently falls back and your type renders
in something you did not choose, which is what has been happening. There is no
network during rendering, so a webfont URL resolves to nothing. Use a family from
that list, or embed a font as a data URI in the composition. Do not search the
filesystem for fonts.

### The framework
Load the \`hyperframes\` skill once, at the start. Do not open the skill
directories by hand, do not read their reference markdown, and do not grep them.
The rules that matter for this job are written below in full; the reference tree
runs to megabytes and re-reading it is how a turn is lost.
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

/**
 * Typography and graphics, which is where the last render actually failed.
 *
 * The motion rules below it are about the camera and they were followed. What
 * came back was still five photographs at rest with one small label in the
 * corner of each, because nothing in this file ever said the type had to move,
 * that captions were required, or that anything should be drawn on top of the
 * image. An agent given no instruction about a layer does not invent one.
 */
const GRAPHICS = `
## The type is the motion graphics, not a caption on a photo

The most common failure on this pipeline is a bought photograph shown whole, at
rest, with one small static label in a corner. That is a slide with a watermark.
Every rule here is a requirement.

### Captions are mandatory
Word timings were bought for this job and are on disk as a transcript. Build
real captions from them:
  - Every spoken word appears on screen, synchronised to its own timing. Do not
    estimate, do not paraphrase, do not caption only the headline lines.
  - Group into phrases of 3 to 7 words. A caption that changes on every single
    word is strobing; one that holds a whole sentence is a subtitle track.
  - Animate the transition between phrases. Mask reveal, per-word stagger, or a
    weight or tracking shift. A hard cut between caption blocks is not motion.
  - Set them in the lower third with real margin, never flush to the frame edge,
    and give them a scrim or shadow so they survive a bright plate underneath.
A job that buys word timings and renders no captions has thrown away an asset
the buyer paid for.

### Type must animate in and out
No element arrives by opacity alone and nothing is ever simply present.
  - Reveal type behind a moving mask, or stagger it by word or character, or
    transition its weight, tracking or size. Pick one per register and hold it.
  - Type carries the ambient idle too: a slow tracking drift or a 1% scale.
  - Text leaves deliberately. It never simply disappears between frames.

### Build a type hierarchy, not one label
At least three registers, visibly different in size, weight and treatment:
a display line for the idea of the scene, a supporting line or kicker, and small
uppercase utility type with wide tracking for labels and numbers. A single size
used everywhere is what makes a frame look empty.

### Draw on top of the image
Each scene carries at least three graphic elements that are not photography:
measurement rules with tick marks, callout lines that connect a label to a real
point in the plate, framing brackets or crop marks, a numeric readout that
counts, a progress or timeline indicator, an underline that draws itself, a
divider that extends. Keep them in the accent and the neutrals; they are
instruments, not decoration. They must be tied to the composition's timeline so
they draw, extend or count rather than appearing whole.

### The images are assets to compose with, not wallpaper
The default failure is to stretch a photograph across all 1920x1080, drop a word
on top, and call it a scene. That is a background with a caption. The plate is a
design element and should be placed, sized and shaped like one.

Build a layout. Reach for these rather than full bleed:
  - the plate inside a frame, card or masked shape, with the ground visible
    around it and the layout holding it in place
  - a split: plate on one side, type and graphics on the other, on a real grid
  - an inset or picture-in-picture against a plain ground, offset from centre
  - two or three plates on screen at once, compared, sequenced, or stacked with
    depth between them
  - a plate masked into a shape the subject implies, a slot, a rail, an aperture
  - a plate that moves as an object: sliding in as a panel, scaling from a mark,
    being pushed aside by the next one

Full bleed is allowed, but as a deliberate move for one or two beats, usually
the opening or the spectacle. If every scene is full bleed you have made a
slideshow with a soundtrack.

The ground matters. Negative space in the brand's own colour, with the plate
sitting in it, reads as designed. An image with no visible ground has nothing to
be composed against.

### Frame tight, and leave room to move
A plate shown whole and centred has nowhere to go. Place every image at 1.15 to
1.3 scale so the camera has travel, and crop deliberately: go past the edge of
the subject rather than fitting it politely inside the frame. Vary the framing
across scenes. Two consecutive scenes at the same distance read as one static
shot, however much the camera moves within them.
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
    known({ media: job.media ?? [], fonts: job.fonts ?? [], narrationSeconds: job.narrationSeconds }),
    ``,
    MOTION,
    ``,
    GRAPHICS,
    ``,
    CONTINUITY,
    ``,
    DETERMINISM,
    ``,
    GATE,
    ``,
    `## Deliverables`,
    ``,
    `index.html is the deliverable and the only one. STORYBOARD.md is already`,
    `written and handed to you; do not rewrite it, and do not author further`,
    `planning documents. Prose about the video is not progress on the video.`,
    ``,
    `Plan in your head against the beat formula, element, motion, layout, style,`,
    `timing, using real timestamps taken from the narration, then build. Quote all`,
    `on-screen copy exactly. Name any registry block you adapt in an HTML comment`,
    `at the point you use it.`,
  ].join("\n");
}

export { MOTION, GRAPHICS, CONTINUITY, DETERMINISM, GATE };
