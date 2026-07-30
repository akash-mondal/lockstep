/**
 * The upstream asset suppliers — what the content agent actually buys.
 *
 * Three different models, three genuinely different call shapes, none of them
 * guessable from the model list. Everything here was established by calling the
 * live API, because the metadata is misleading in three separate ways:
 *
 *   - The TTS model reports output modality `speech`, which is not a legal value
 *     for `modalities` and 404s as `audio`. It is not on /chat/completions at all;
 *     it lives on the OpenAI-compatible /audio/speech endpoint.
 *   - Lyria refuses non-streaming requests outright ("Audio output requires
 *     stream: true") and delivers audio as base64 inside SSE deltas.
 *   - `lyria-3-pro-preview` accepts the request and returns `[[A0]] [[A1]]`
 *     segment markers with no audio and cost 0. The `clip` variant returns real
 *     MP3. Only clip is usable.
 *
 * Every function returns `{ bytes, contentType, cost, ... }` so the foundry above
 * it can price a job from what the suppliers actually charged rather than from a
 * table that drifts.
 */
import "dotenv/config";

const BASE = "https://openrouter.ai/api/v1";
const KEY = process.env.ASSET_API_KEY ?? process.env.OPENROUTER_API_KEY;

const IMAGE_MODEL = process.env.IMAGE_MODEL ?? "google/gemini-3.1-flash-lite-image";
const TTS_MODEL = process.env.TTS_MODEL ?? "google/gemini-3.1-flash-tts-preview";
const MUSIC_MODEL = process.env.MUSIC_MODEL ?? "google/lyria-3-clip-preview";

function auth() {
  if (!KEY) throw new Error("ASSET_API_KEY is not set");
  return { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
}

/**
 * A scene image.
 *
 * `seed` is supported and matters more here than it usually does: an asset the
 * agent can regenerate byte-identically is an asset it can cache, and at 3.3
 * cents a call the difference between caching and not is the whole margin.
 *
 * The model also accepts images as input, so a previous scene can be passed back
 * in as a style reference to keep a look consistent across a storyboard.
 */
export async function image({ prompt, seed, styleRef = null, aspect = "16:9" }) {
  const content = styleRef
    ? [
        { type: "text", text: `${prompt}\n\nMatch the visual style of the reference image.` },
        { type: "image_url", image_url: { url: styleRef } },
      ]
    : `${prompt}\n\nAspect ratio ${aspect}. No text, no captions, no watermarks.`;

  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({
      model: IMAGE_MODEL,
      messages: [{ role: "user", content }],
      modalities: ["image", "text"],
      ...(seed === undefined ? {} : { seed }),
    }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`image: ${j.error.message ?? JSON.stringify(j.error)}`);

  // Arrives as a data: URL rather than raw bytes or a link.
  const url = j.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!url) throw new Error("image: model returned no image");
  const [meta, b64] = url.split(",");
  return {
    bytes: Buffer.from(b64, "base64"),
    contentType: /data:([^;]+)/.exec(meta)?.[1] ?? "image/jpeg",
    cost: Number(j.usage?.cost ?? 0),
    imageTokens: j.usage?.completion_tokens_details?.image_tokens ?? null,
    model: IMAGE_MODEL,
  };
}

/** 24 kHz mono 16-bit PCM, wrapped so a browser will actually play it. */
function pcmToWav(pcm, { rate = 24_000, channels = 1, bits = 16 } = {}) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE((rate * channels * bits) / 8, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Narration.
 *
 * The endpoint returns *raw PCM* with no container — `audio/pcm;rate=24000`.
 * Handing that to a browser or to ffmpeg without a header gets silence or an
 * error, so it is wrapped here rather than left as a trap for the caller.
 *
 * There is no `usage` object on a binary response, so cost is not knowable per
 * call from the response alone. Duration is, and it is derivable exactly from
 * the byte count, which is the number worth reporting.
 */
export async function narrate({ text, voice = "Kore" }) {
  const res = await fetch(`${BASE}/audio/speech`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ model: TTS_MODEL, input: text, voice }),
  });
  if (!res.ok) {
    throw new Error(`narrate: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const type = res.headers.get("content-type") ?? "";
  const raw = Buffer.from(await res.arrayBuffer());
  const rate = Number(/rate=(\d+)/.exec(type)?.[1] ?? 24_000);
  const channels = Number(/channels=(\d+)/.exec(type)?.[1] ?? 1);

  // Only wrap if it really is headerless PCM; if they ever return WAV, pass through.
  const isWav = raw.subarray(0, 4).toString() === "RIFF";
  return {
    bytes: isWav ? raw : pcmToWav(raw, { rate, channels }),
    contentType: "audio/wav",
    seconds: raw.length / 2 / channels / rate,
    cost: null, // not reported on a binary response
    model: TTS_MODEL,
    voice,
  };
}

/**
 * A music bed.
 *
 * Streaming is mandatory, the audio arrives base64-encoded in SSE deltas, and the
 * `format` field is null even though the payload is MP3 — so the type is asserted
 * from the magic bytes rather than believed.
 */
export async function music({ prompt }) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({
      model: MUSIC_MODEL,
      messages: [{ role: "user", content: `${prompt} Instrumental, no vocals.` }],
      modalities: ["audio", "text"],
      stream: true,
    }),
  });
  if (!res.ok) throw new Error(`music: ${res.status} ${(await res.text()).slice(0, 200)}`);

  const parts = [];
  let usage = null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const body = line.slice(6).trim();
      if (body === "[DONE]") continue;
      let ev;
      try { ev = JSON.parse(body); } catch { continue; }
      if (ev.usage) usage = ev.usage;
      const data = ev.choices?.[0]?.delta?.audio?.data;
      if (data) parts.push(Buffer.from(data, "base64"));
    }
  }
  const bytes = Buffer.concat(parts);
  if (!bytes.length) {
    throw new Error(
      `music: ${MUSIC_MODEL} returned no audio. lyria-3-pro-preview is known to ` +
      `return [[A0]] segment markers instead of audio — use lyria-3-clip-preview.`,
    );
  }
  const head = bytes.subarray(0, 3).toString("hex");
  return {
    bytes,
    contentType: head === "494433" || head.startsWith("fff") ? "audio/mpeg" : "application/octet-stream",
    cost: Number(usage?.cost ?? 0),
    model: MUSIC_MODEL,
  };
}

/**
 * Word-level timestamps for narration we already bought.
 *
 * HyperFrames wants a transcript to place captions and to pace reveals to the
 * spoken word, and its local whisper path is not installed on this machine by
 * choice. Scribe returns the timings directly and bills separately from the
 * text-to-speech quota, so transcribing does not eat the budget for speaking.
 *
 * Returned in HyperFrames' own shape, `[{text, start, end}]`, so it can be
 * written straight to transcript.json without a translation step.
 */
export async function transcribe({ bytes, filename = "narration.wav" }) {
  const key = process.env.STT_API_KEY;
  if (!key) throw new Error("STT_API_KEY is not set");

  const form = new FormData();
  form.append("file", new Blob([bytes]), filename);
  form.append("model_id", process.env.STT_MODEL ?? "scribe_v1");
  form.append("timestamps_granularity", "word");

  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": key },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`transcribe: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const j = await res.json();
  // Scribe interleaves spacing entries with words; only words carry meaning here.
  const words = (j.words ?? [])
    .filter((w) => w.type === "word")
    .map((w) => ({ text: w.text, start: w.start, end: w.end }));
  return {
    text: j.text ?? "",
    language: j.language_code ?? null,
    confidence: j.language_probability ?? null,
    words,
    model: process.env.STT_MODEL ?? "scribe_v1",
  };
}

/** What a supplier call costs, for pricing a job before running it. */
export const OBSERVED_COST = {
  image: 0.033, // per image, gemini-3.1-flash-lite-image, ~1120 image tokens
  music: 0.0396, // per clip, lyria-3-clip-preview, ~26s of MP3
  narration: 0, // not reported per call; small
  transcribe: 0, // billed apart from the speech quota
};
