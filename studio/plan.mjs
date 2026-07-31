/**
 * Turn a brief into a storyboard the rest of the pipeline can price and buy.
 *
 * This is the one step where the agent's judgment is the product: what the video
 * should be about, how it breaks into scenes, what each scene shows, what the
 * narrator says. Everything downstream is mechanical.
 *
 * The plan is deliberately narrow. It does not decide prices, does not name
 * accounts, and does not choose how much to spend: it says what the video is,
 * and the studio works out what that costs. A model that could set its own
 * budget is a model that can be argued into setting a bad one.
 */
import { agentJson } from "./harness.mjs";

const SCHEMA = `{
  "title": "short title for the finished video",
  "angle": "concept | how-to | listicle | narrative",
  "look": "one sentence naming palette and typographic direction",
  "continuity": "the one device that carries the eye across every scene boundary",
  "spectacle": "the single exaggerated moment, and where it lands",
  "scenes": [
    { "id": 1,
      "role": "hook | problem | turn | mechanism | proof | close",
      "idea": "the ONE idea this scene teaches",
      "visual": "photograph | diagram | data | interface | type",
      "imagePrompt": "photograph scenes only: subject, composition, lighting, no text. null otherwise",
      "build": "every other kind: exactly what to construct in HTML. Name the boxes, arrows, rows, numbers, labels and what animates",
      "onScreen": "exact words that appear, quoted, or null",
      "motion": "what moves and why, in the framework's own vocabulary" }
  ],
  "narration": ["one line per scene, in order, as it should be spoken"],
  "music": "one sentence describing the bed, instrumental"
}`;

/**
 * Draft the storyboard.
 *
 * Constraints in the prompt exist because each one has a cost downstream: an
 * extra scene is another image bought, an unnamed continuity device produces a
 * slideshow, and prose where quoted copy belongs gets paraphrased by the builder
 * into something the buyer never approved.
 */
export async function draftPlan({
  sessionId, brief, style = null, maxScenes = 6, attachments = [], conversation = [], previous = null,
}) {
  // Files the requester attached. The agent reads them itself rather than being
  // handed a summary, because a brief that arrives as a script or a brand sheet
  // is the brief, and paraphrasing it loses exactly the detail it was sent for.
  const attached = attachments.length
    ? [``, `The requester attached these files. Read them before planning:`,
       ...attachments.map((a) => `  ${a.rel}   ${a.note ?? ""}`)].join("\n")
    : "";

  // What has already been agreed, so a revision does not silently undo it.
  const agreed = conversation.length
    ? [``, `This plan is being revised. The conversation so far:`,
       ...conversation.map((m) => `  ${m.from}: ${m.text}`),
       previous ? `` : ``,
       previous ? `Keep everything not under discussion exactly as it was:` : ``,
       previous ? JSON.stringify({ title: previous.title, scenes: previous.scenes.map((x) => x.idea) }) : ``,
      ].filter(Boolean).join("\n")
    : "";

  const prompt = [
    `Plan a short narrated video.`,
    ``,
    `Brief: ${brief}`,
    style ? `Style: ${style}` : ``,
    ``,
    `## Structure. Give every scene a job.`,
    ``,
    `Explainers fail the same way: they open with the product instead of the`,
    `viewer's problem, and they narrate a feature list. Assign each scene a role`,
    `and write to it.`,
    ``,
    `  hook       the painful situation the viewer already recognises. Never the`,
    `             product, never a greeting, never the company name.`,
    `  problem    what it costs them. Concrete, with a number if one is honest.`,
    `  turn       what changes. The transformation, before the mechanism.`,
    `  mechanism  how it actually works, in exactly three steps. Not two, not five.`,
    `  proof      something checkable. A figure, a record, a named consequence.`,
    `  close      one specific thing to do or understand, tied back to the hook.`,
    ``,
    `Not every role is needed, but hook and turn always are, and the hook is`,
    `never about the product.`,
    ``,
    `## Length`,
    ``,
    `Narration runs about 150 words per 60 seconds when spoken. Write to that.`,
    `Every clause must earn its place; cut a draft by a third and it improves.`,
    `Read each line aloud in your head, and if you stumble, the narrator will.`,
    ``,
    `## It must work on mute`,
    ``,
    `Most viewers see this without sound. The on-screen words carry the argument`,
    `by themselves, and the narration agrees with them rather than repeating them`,
    `verbatim. If the piece makes no sense muted, it is not finished.`,
    ``,
    `## Every line points at a specific picture`,
    ``,
    `A narration line and its visual must be the same claim. If the line says a`,
    `limit is enforced, the screen shows the limit enforcing something, not a`,
    `metaphor for safety. Vague line, vague picture.`,
    ``,
    `## Vary what a scene actually is`,
    ``,
    `This is the difference between a film and a slideshow with narration. A`,
    `piece where every scene is a photograph of the same object is the failure to`,
    `avoid. Choose the kind that carries the idea:`,
    ``,
    `  photograph  a bought image. Use where atmosphere or a physical object`,
    `              carries meaning. Costs money, so spend it where it earns.`,
    `  diagram     boxes, arrows, flows, a system drawn and animated. Use for`,
    `              architecture and for anything with parts that relate.`,
    `  data        numbers that move: a counter, a bar, a ledger filling, a`,
    `              before and after pair. Use to show a quantity changing.`,
    `  interface   a rendered request, response, terminal, receipt or wallet`,
    `              prompt. Use to show the thing actually happening.`,
    `  type        words as the whole image, set large and animated.`,
    ``,
    `Only photograph scenes buy an image. Everything else is built in the`,
    `composition, costs nothing, and usually explains a technical idea better`,
    `than any photograph could. Use at most ${Math.max(1, Math.ceil(maxScenes / 2))}`,
    `photograph scenes out of ${maxScenes}, and do not use two of the same kind`,
    `back to back.`,
    ``,
    `For a non-photograph scene, "build" is a specification, not a mood. Name the`,
    `boxes and their labels, the arrows and their direction, the rows, the exact`,
    `numbers, what counts up, what turns red, what is struck through.`,
    ``,
    `## Before and after is usually the strongest shape`,
    ``,
    `When something changes behaviour, show the same situation twice: once`,
    `without the thing and once with it, in the same layout, so the difference is`,
    `the only thing that moves. Say what the viewer is looking at both times.`,
    ``,
    `## Rules that cost money or quality downstream`,
    `  - At most ${maxScenes} scenes.`,
    `  - One idea per scene. Two leaves nothing to build motion around.`,
    `  - One narration line per scene, in the same order. Short clauses, no`,
    `    parentheses, no lists, no semicolons.`,
    `  - Name a continuity device: the one thing crossing every boundary.`,
    `  - Name one spectacle beat and where it lands. Everything else restrained.`,
    `  - Image prompts describe a picture, never text. Generated lettering is`,
    `    unreliable; on-screen words are set in the composition instead.`,
    `  - onScreen copy is quoted exactly or null. Unquoted copy gets paraphrased.`,
    ``,
    `## Do not write like this`,
    ``,
    `No "In today's world". No "Welcome to". No "imagine a world where". No`,
    `rule-of-three adjective lists. No sentence whose removal changes nothing. No`,
    `word you would not say out loud to a colleague.`,
    ``,
    `Do not mention price, budget, accounts or payment. That is not your decision.`,
    attached,
    agreed,
  ].filter(Boolean).join("\n");

  const { json } = await agentJson({
    sessionId,
    prompt,
    schemaHint: SCHEMA,
    allowedTools: attachments.length ? ["Read", "Glob"] : [],
    maxTurns: attachments.length ? 12 : 4,
  });
  if (!json?.scenes?.length) return null;

  // Trust the shape, not the count: a model asked for six scenes will sometimes
  // return nine, and every extra one is an image nobody agreed to buy.
  const KINDS = new Set(["photograph", "diagram", "data", "interface", "type"]);
  const scenes = json.scenes.slice(0, maxScenes).map((s, i) => {
    const visual = KINDS.has(s.visual) ? s.visual : "photograph";
    return {
      id: i + 1,
      role: s.role ?? null,
      idea: String(s.idea ?? "").slice(0, 300),
      visual,
      // Only a photograph scene buys anything. The flag is what pricing counts,
      // so a plan of diagrams and data costs the buyer a fraction of one made
      // entirely of bought images, and usually explains more.
      image: visual === "photograph",
      imagePrompt: visual === "photograph"
        ? String(s.imagePrompt ?? s.idea ?? "").slice(0, 600)
        : null,
      build: visual === "photograph" ? null : String(s.build ?? s.idea ?? "").slice(0, 800),
      onScreen: s.onScreen ?? null,
      motion: s.motion ?? null,
    };
  });

  const narration = (json.narration ?? [])
    .slice(0, scenes.length)
    .map((n) => String(n).trim())
    .filter(Boolean);

  return {
    title: String(json.title ?? "Untitled").slice(0, 120),
    angle: json.angle ?? "concept",
    look: json.look ?? null,
    continuity: json.continuity ?? null,
    spectacle: json.spectacle ?? null,
    scenes,
    narration,
    music: json.music ?? "Sparse ambient bed, warm pads, no drums, instrumental.",
  };
}
