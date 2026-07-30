/**
 * The asset foundry: three generative models, sold over x402.
 *
 * This is the supply side of Prism Studio. The studio's agent buys an image, a
 * line of narration or a music bed here, one x402 settlement per call, and the
 * foundry is an ordinary vendor that happens to be bought from by software.
 *
 * Settling in native HBAR is deliberate. The foundry does not refract: it is a
 * straight metered sale to one seller, so there is nothing to divide and no
 * reason to mint a token for it. Refraction belongs one level up, on the sale of
 * the finished video, where several parties are genuinely owed a share. Keeping
 * the two levels on different assets also sidesteps the fee-exemption trap,
 * since an account that collects on the studio's token would silently skip the
 * split if it were also paying here.
 *
 * Prices are fixed per SKU and quoted before the work runs, because x402 `exact`
 * has no refund path. Where a model's cost varies, the quote covers the observed
 * ceiling and the foundry absorbs the difference.
 */
import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { image, narrate, music } from "../studio/suppliers.mjs";

const PORT = Number(process.env.FOUNDRY_PORT ?? 4061);
const PAY_TO = process.env.FOUNDRY_OPERATOR_ID;
const ORIGIN = process.env.FOUNDRY_ORIGIN ?? `http://localhost:${PORT}`;
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "https://x402.org/facilitator";

if (!PAY_TO) {
  console.error("FOUNDRY_OPERATOR_ID is required: it is the account that gets paid.");
  process.exit(1);
}

/**
 * Prices in tinybar.
 *
 * Derived from measured supplier cost, not guessed. An image costs ~3.4¢ and a
 * music clip 4¢ to 8¢ depending on a duration the model does not let us choose,
 * so music is quoted at its ceiling. Narration is priced above its true cost
 * mostly to make the route worth serving at all.
 */
const PRICE = {
  image: "25000000",   // 0.25 ℏ
  speech: "5000000",   //  0.05 ℏ
  music: "50000000",   //  0.50 ℏ, covering the 2x duration variance
};

const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const server = new x402ResourceServer(facilitator);
server.register("hedera:*", new ExactHederaScheme());

const paid = (amount, description, tags) => ({
  accepts: [{
    scheme: "exact",
    network: "hedera:testnet",
    price: { asset: "0.0.0", amount },   // native HBAR
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
  }],
  description,
  mimeType: "application/json",
  serviceName: "Prism Foundry",
  tags,
});

const routes = {
  "POST /v1/image": paid(PRICE.image,
    "Generate a still image from a prompt. Returns base64 with the model's own cost.",
    ["hedera", "x402", "image", "generative", "agent-payments"]),
  "POST /v1/speech": paid(PRICE.speech,
    "Generate narration from text. Returns WAV, 24 kHz mono.",
    ["hedera", "x402", "tts", "speech", "agent-payments"]),
  "POST /v1/music": paid(PRICE.music,
    "Generate an instrumental music bed from a description. Returns MP3.",
    ["hedera", "x402", "music", "generative", "agent-payments"]),
};

const app = new Hono();
app.use(paymentMiddleware(routes, server));

/** Read a JSON body without letting a malformed one become a 500. */
const body = async (c) => {
  try { return await c.req.json(); } catch { return null; }
};

app.post("/v1/image", async (c) => {
  const b = await body(c);
  if (!b?.prompt) return c.json({ error: "prompt is required" }, 400);
  try {
    const r = await image({ prompt: b.prompt, seed: b.seed, aspect: b.aspect, styleRef: b.styleRef });
    return c.json({
      contentType: r.contentType,
      bytes: r.bytes.length,
      data: r.bytes.toString("base64"),
      // The buyer sees what the work cost us, which is the honest basis for the
      // price and lets an agent reason about whether the margin is fair.
      upstreamCostUsd: r.cost,
      model: r.model,
    });
  } catch (err) {
    return c.json({ error: String(err.message ?? err) }, 502);
  }
});

app.post("/v1/speech", async (c) => {
  const b = await body(c);
  if (!b?.text) return c.json({ error: "text is required" }, 400);
  try {
    const r = await narrate({ text: b.text, voice: b.voice });
    return c.json({
      contentType: r.contentType,
      bytes: r.bytes.length,
      seconds: Number(r.seconds.toFixed(2)),
      data: r.bytes.toString("base64"),
      model: r.model,
      voice: r.voice,
    });
  } catch (err) {
    return c.json({ error: String(err.message ?? err) }, 502);
  }
});

app.post("/v1/music", async (c) => {
  const b = await body(c);
  if (!b?.prompt) return c.json({ error: "prompt is required" }, 400);
  try {
    const r = await music({ prompt: b.prompt });
    return c.json({
      contentType: r.contentType,
      bytes: r.bytes.length,
      data: r.bytes.toString("base64"),
      upstreamCostUsd: r.cost,
      model: r.model,
    });
  } catch (err) {
    return c.json({ error: String(err.message ?? err) }, 502);
  }
});

// ------------------------------------------------------------------ free
app.get("/health", (c) => c.json({ ok: true, payTo: PAY_TO, facilitator: FACILITATOR_URL }));

app.get("/v1/catalogue", (c) =>
  c.json({
    seller: PAY_TO,
    network: "hedera:testnet",
    asset: "0.0.0",
    note: "Native HBAR. This is a straight metered sale, so nothing here refracts.",
    skus: [
      { route: "POST /v1/image", tinybar: PRICE.image, hbar: 0.25, body: { prompt: "string", seed: "number?", aspect: "string?" } },
      { route: "POST /v1/speech", tinybar: PRICE.speech, hbar: 0.05, body: { text: "string", voice: "string?" } },
      { route: "POST /v1/music", tinybar: PRICE.music, hbar: 0.5, body: { prompt: "string" } },
    ],
  }));

const discovery = {
  version: 1,
  x402Version: 2,
  name: "Prism Foundry",
  description: "Generative assets for agents: images, narration and music, priced per call in HBAR.",
  resources: [`${ORIGIN}/v1/image`, `${ORIGIN}/v1/speech`, `${ORIGIN}/v1/music`],
};
app.get("/.well-known/x402", (c) => c.json(discovery));
app.get("/.well-known/x402.json", (c) => c.json(discovery));

serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" }, (info) => {
  console.log(`Prism Foundry on :${info.port}`);
  console.log(`  payTo       ${PAY_TO}   asset 0.0.0 (HBAR)`);
  console.log(`  facilitator ${FACILITATOR_URL}`);
  console.log(`  paid        POST /v1/image  0.25 ℏ   POST /v1/speech 0.05 ℏ   POST /v1/music 0.50 ℏ`);
  console.log(`  free        GET /v1/catalogue  /health  /.well-known/x402`);
});
