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
import { readFileSync } from "node:fs";
import { agentJson } from "./harness.mjs";

const state = JSON.parse(readFileSync(new URL("../.state.json", import.meta.url), "utf8"));

const SCHEMA = `{
  "title": "short title for the finished video",
  "angle": "concept | how-to | listicle | narrative",
  "look": "one sentence naming palette and typographic direction",
  "continuity": "the one device that carries the eye across every scene boundary",
  "spectacle": "the single exaggerated moment, and where it lands",
  "scenes": [
    { "id": 1,
      "idea": "the ONE idea this scene teaches",
      "imagePrompt": "what to generate: subject, composition, lighting, no text",
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
    `Rules that matter, because each one costs money or quality downstream:`,
    `  - At most ${maxScenes} scenes. Every scene buys one generated image.`,
    `  - One idea per scene. Two ideas leaves nothing to build the motion around`,
    `    and reads as a text dump.`,
    `  - One narration line per scene, in the same order. Write them to be spoken,`,
    `    not read: short clauses, no parentheses, no lists.`,
    `  - Name a continuity device: the one thing that crosses every scene boundary`,
    `    so the piece reads as one space rather than slides in order.`,
    `  - Name one spectacle beat and where it lands. Everything else stays`,
    `    restrained. An unnamed spectacle beat gets dropped.`,
    `  - Image prompts describe a picture, never text. Generated lettering is`,
    `    unreliable; on-screen words are set in the composition instead.`,
    `  - onScreen copy is quoted exactly or null. Unquoted copy gets paraphrased.`,
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
  const scenes = json.scenes.slice(0, maxScenes).map((s, i) => ({
    id: i + 1,
    idea: String(s.idea ?? "").slice(0, 300),
    imagePrompt: String(s.imagePrompt ?? s.idea ?? "").slice(0, 600),
    onScreen: s.onScreen ?? null,
    motion: s.motion ?? null,
  }));

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
    // Recorded on the plan so the receipt can label accounts without guessing.
    parties: {
      studio: state.studio.studio.id,
      upstream: state.studio.upstream.id,
      referrer: state.studio.referrer.id,
    },
  };
}
