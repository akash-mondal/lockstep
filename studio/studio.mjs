/**
 * Prism Studio: sells finished videos to agents.
 *
 * Two phases, because `exact` needs a fixed price before the work and the cost
 * of a video is not knowable until it has been planned. So planning is its own
 * cheap purchase that returns a quote, and rendering is priced from the plan it
 * refers to. x402 blesses a per-request price callback, so this stays inside the
 * standard rather than working around it.
 *
 *   POST /v1/quote       0.05 ℏ in HBAR    plan the video, return a firm price
 *   POST /v1/render      quoted, in STUD   buy it; refracts to the value chain
 *   GET  /v1/job/:id     free              how it is going
 *   GET  /v1/receipt/:id free              the bill, every line on HashScan
 *   GET  /v1/download/:id?token=  free     the video
 *
 * The two assets are deliberate. A quote is a straight metered sale with nobody
 * to divide it among, so it settles in HBAR. A finished video is the output of a
 * value chain, so it settles in STUD, whose fee schedule pays that chain at
 * consensus.
 */
import { readFileSync } from "node:fs";
import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import * as sessions from "./sessions.mjs";
import { priceJob, budgetFor, hbar } from "./pricing.mjs";
import { draftPlan } from "./plan.mjs";
import { runJob } from "./worker.mjs";
import { buildReceipt } from "./receipt.mjs";

const state = JSON.parse(readFileSync(new URL("../.state.json", import.meta.url), "utf8"));
const STUD = state.studio.tokenId;
const PAY_TO = state.studio.studio.id;
const PORT = Number(process.env.STUDIO_PORT ?? 4071);
const ORIGIN = process.env.STUDIO_ORIGIN ?? `http://localhost:${PORT}`;
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "https://x402.org/facilitator";
const QUOTE_PRICE = "5000000"; // 0.05 ℏ

const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const server = new x402ResourceServer(facilitator);
server.register("hedera:*", new ExactHederaScheme());

/**
 * The render price is whatever the referenced plan was quoted.
 *
 * Read from stored state, never from the request: the buyer supplies a plan id,
 * and a buyer must not be able to name its own price. An unknown or already-sold
 * plan quotes a number nobody will pay, which is how this scheme expresses a
 * refusal.
 */
const UNSELLABLE = "999999999999";
const renderPrice = (ctx) => {
  const id = ctx?.req?.query?.("plan") ?? ctx?.query?.plan ?? null;
  const s = id ? sessions.read(id) : null;
  if (!s?.plan || s.state !== "quoted") return { asset: STUD, amount: UNSELLABLE };
  return { asset: STUD, amount: s.plan.pricing.quoteTinybar };
};

const routes = {
  "POST /v1/quote": {
    accepts: [{
      scheme: "exact", network: "hedera:testnet",
      price: { asset: "0.0.0", amount: QUOTE_PRICE },
      payTo: PAY_TO, maxTimeoutSeconds: 300,
    }],
    description: "Plan a video from a brief and return a firm price for rendering it.",
    mimeType: "application/json",
    serviceName: "Prism Studio",
    tags: ["hedera", "x402", "video", "agent-payments"],
  },
  "POST /v1/render": {
    accepts: [{
      scheme: "exact", network: "hedera:testnet",
      price: renderPrice,
      payTo: PAY_TO, maxTimeoutSeconds: 600,
    }],
    description: "Buy a planned video. The payment refracts to the value chain at consensus.",
    mimeType: "application/json",
    serviceName: "Prism Studio",
    tags: ["hedera", "x402", "video", "revenue-split", "agent-payments"],
  },
};

const app = new Hono();
app.use(paymentMiddleware(routes, server));

const body = async (c) => { try { return await c.req.json(); } catch { return null; } };

/**
 * Plan the video, then price it.
 *
 * The agent decides what the video should be; this decides what it costs. Those
 * stay apart deliberately: a model that can set its own price is a model that
 * can be talked into setting a bad one.
 */
app.post("/v1/quote", async (c) => {
  const b = await body(c);
  if (!b?.brief) return c.json({ error: "brief is required" }, 400);

  const session = sessions.createSession({
    task: { brief: b.brief, aspect: b.aspect ?? "1920x1080", style: b.style ?? null },
    requester: b.requester ?? null,
  });
  try {
    sessions.setState(session.id, "planning");
    const drafted = await draftPlan({ sessionId: session.id, brief: b.brief, style: b.style });
    if (!drafted) {
      sessions.setState(session.id, "failed", { error: "could not plan this brief" });
      return c.json({ error: "could not plan this brief", planId: session.id }, 502);
    }
    const pricing = priceJob(drafted);
    sessions.update(session.id, (s) => {
      s.plan = { ...drafted, pricing, budgetTinybar: budgetFor(pricing) };
      s.state = "quoted";
      return s;
    });
    return c.json({
      planId: session.id,
      title: drafted.title,
      scenes: drafted.scenes.length,
      narrationLines: (drafted.narration ?? []).length,
      quote: {
        tinybar: pricing.quoteTinybar,
        stud: hbar(pricing.quoteTinybar),
        asset: STUD,
        // The buyer sees where its money goes before it spends any.
        splitsTo: {
          studio: hbar(pricing.breakdown.studio),
          upstream: hbar(pricing.breakdown.upstream),
          referrer: hbar(pricing.breakdown.referrer),
        },
      },
      buy: `POST ${ORIGIN}/v1/render?plan=${session.id}`,
      note: "A plan is sellable once. Re-quote to buy again.",
    });
  } catch (err) {
    sessions.setState(session.id, "failed", { error: String(err.message ?? err) });
    return c.json({ error: String(err.message ?? err), planId: session.id }, 502);
  }
});

/**
 * Buy a planned video.
 *
 * Settlement completes before this response is flushed, so the payment is final
 * by the time a job id comes back. The render itself takes minutes and runs
 * detached: holding the connection open for it would risk a timeout on money
 * that has already moved.
 */
app.post("/v1/render", async (c) => {
  const id = c.req.query("plan");
  const s = id ? sessions.read(id) : null;
  if (!s?.plan) return c.json({ error: "unknown plan" }, 404);
  if (s.state !== "quoted") {
    return c.json({ error: `plan is ${s.state}, not for sale`, state: s.state }, 409);
  }
  sessions.setState(id, "paid");
  runJob(id).catch((err) => sessions.setState(id, "failed", { error: String(err.message ?? err) }));
  return c.json({
    jobId: id,
    state: "paid",
    poll: `${ORIGIN}/v1/job/${id}`,
    receipt: `${ORIGIN}/v1/receipt/${id}`,
    note: "Rendering takes a few minutes. The receipt fills in as purchases settle.",
  }, 202);
});

app.get("/v1/job/:id", (c) => {
  const s = sessions.read(c.req.param("id"));
  if (!s) return c.json({ error: "no such job" }, 404);
  return c.json({
    jobId: s.id,
    state: s.state,
    title: s.plan?.title ?? null,
    progress: s.progress ?? null,
    purchases: s.ledger.length,
    artifacts: s.artifacts.map((a) => ({ name: a.name, bytes: a.bytes })),
    error: s.error,
    ...(s.state === "delivered"
      ? { download: `${ORIGIN}/v1/download/${s.id}?token=${s.downloadToken}` }
      : {}),
  });
});

app.get("/v1/receipt/:id", async (c) => {
  const s = sessions.read(c.req.param("id"));
  if (!s) return c.json({ error: "no such job" }, 404);
  return c.json(await buildReceipt(s, { origin: ORIGIN, token: STUD }));
});

/**
 * The finished video, behind an unguessable token rather than the job id, so
 * knowing a job exists is not the same as being able to fetch what it produced.
 */
app.get("/v1/download/:id", (c) => {
  const s = sessions.read(c.req.param("id"));
  if (!s) return c.json({ error: "no such job" }, 404);
  if (c.req.query("token") !== s.downloadToken) return c.json({ error: "no such job" }, 404);
  const art = s.artifacts.find((a) => a.name.endsWith(".mp4"));
  if (!art) return c.json({ error: "nothing delivered yet", state: s.state }, 409);
  const bytes = readFileSync(sessions.safePath(s.id, art.rel));
  return new Response(bytes, {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(bytes.length),
      "Content-Disposition": `inline; filename="${art.name}"`,
      "X-Sha256": art.sha256 ?? "",
    },
  });
});

app.get("/health", (c) =>
  c.json({ ok: true, asset: STUD, payTo: PAY_TO, facilitator: FACILITATOR_URL }));

const discovery = {
  version: 1, x402Version: 2,
  name: "Prism Studio",
  description: "Finished videos for agents. One payment, divided among the value chain at consensus.",
  resources: [`${ORIGIN}/v1/quote`, `${ORIGIN}/v1/render`],
};
app.get("/.well-known/x402", (c) => c.json(discovery));
app.get("/.well-known/x402.json", (c) => c.json(discovery));

serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" }, (info) => {
  console.log(`Prism Studio on :${info.port}`);
  console.log(`  sells    STUD ${STUD} -> payTo ${PAY_TO}`);
  console.log(`  paid     POST /v1/quote 0.05 ℏ    POST /v1/render <quoted> STUD`);
  console.log(`  free     GET /v1/job/:id  /v1/receipt/:id  /v1/download/:id  /health`);
});
