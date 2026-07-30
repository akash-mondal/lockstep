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
 *   POST /v1/render      quoted, in PRISM   buy it; refracts to the value chain
 *   GET  /v1/job/:id     free              how it is going
 *   GET  /v1/receipt/:id free              the bill, every line on HashScan
 *   GET  /v1/download/:id?token=  free     the video
 *
 * The two assets are deliberate. A quote is a straight metered sale with nobody
 * to divide it among, so it settles in HBAR. A finished video is the output of a
 * value chain, so it settles in PRISM, whose fee schedule pays that chain at
 * consensus.
 */
import { readFileSync, writeFileSync } from "node:fs";
import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import * as sessions from "./sessions.mjs";
import { priceJob, budgetFor, hbar, prism } from "./pricing.mjs";
import { draftPlan } from "./plan.mjs";
import { runJob } from "./worker.mjs";
import { buildReceipt } from "./receipt.mjs";

const state = JSON.parse(readFileSync(new URL("../.state.json", import.meta.url), "utf8"));
const PRISM = state.studio.tokenId;
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

/**
 * The price callback receives {adapter, path, method, paymentHeader, routePattern}.
 * `path` is the matched route with the query stripped, so the plan id only
 * survives on the adapter. Both facts came from logging the context rather than
 * reasoning about it, after two wrong guesses each failed the same silent way:
 * an unreadable id falls through to the refusal price, which looks exactly like
 * a working refusal.
 */
const planIdFrom = (ctx) => {
  // `path` is the matched route without its query, so the adapter is the only
  // place the parameter survives.
  const viaAdapter = ctx?.adapter?.getQueryParam?.("plan");
  if (viaAdapter) return viaAdapter;
  const url = ctx?.adapter?.getUrl?.() ?? "";
  const q = String(url).indexOf("?");
  return q === -1 ? null : new URLSearchParams(String(url).slice(q + 1)).get("plan");
};

const renderPrice = (ctx) => {
  const id = planIdFrom(ctx);
  const s = id ? sessions.read(id) : null;
  if (!s?.plan || s.state !== "quoted") return { asset: PRISM, amount: UNSELLABLE };
  return { asset: PRISM, amount: s.plan.pricing.quoteUnits };
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
  "POST /v1/discuss": {
    accepts: [{
      scheme: "exact", network: "hedera:testnet",
      price: { asset: "0.0.0", amount: QUOTE_PRICE },
      payTo: PAY_TO, maxTimeoutSeconds: 300,
    }],
    description: "Revise a plan before buying it: direction, script, length, scene count.",
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
 * Write what the requester attached into the session's own workspace.
 *
 * Names are treated as untrusted: a requester supplies them, and a supplied name
 * that resolves outside the session is an attempt to write somewhere it was not
 * invited. safePath refuses those rather than trusting intent.
 */
function saveAttachments(id, list) {
  if (!Array.isArray(list) || !list.length) return [];
  const out = [];
  for (const a of list.slice(0, 12)) {
    if (!a?.name || !a?.data) continue;
    const clean = String(a.name).replace(/[^\w.\-]/g, "_").slice(0, 80);
    const rel = `assets/${clean}`;
    writeFileSync(sessions.safePath(id, rel), Buffer.from(a.data, "base64"));
    out.push({ rel, name: clean, note: a.note ?? null });
  }
  sessions.update(id, (s) => { s.attachments = out; return s; });
  return out;
}

/** Enough of the plan for a requester to judge it, without the internals. */
const summarise = (p) => ({
  title: p.title,
  angle: p.angle,
  look: p.look,
  continuity: p.continuity,
  spectacle: p.spectacle,
  scenes: p.scenes.map((x) => ({ id: x.id, idea: x.idea, onScreen: x.onScreen })),
  narration: p.narration,
  music: p.music,
});

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
    const attachments = saveAttachments(session.id, b.attachments);
    const drafted = await draftPlan({
      sessionId: session.id, brief: b.brief, style: b.style, attachments,
    });
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
      readAttachments: attachments.map((a) => a.rel),
      scenes: drafted.scenes.length,
      narrationLines: (drafted.narration ?? []).length,
      quote: {
        units: pricing.quoteUnits,
        prism: prism(pricing.quoteUnits),
        asset: PRISM,
        // The buyer sees where its money goes before it spends any.
        splitsTo: {
          studio: prism(pricing.breakdown.studio),
          upstream: prism(pricing.breakdown.upstream),
          referrer: prism(pricing.breakdown.referrer),
        },
      },
      plan: summarise(drafted),
      discuss: `POST ${ORIGIN}/v1/discuss?plan=${session.id}`,
      buy: `POST ${ORIGIN}/v1/render?plan=${session.id}`,
      note: "Discuss it as many times as you like; the price follows the plan. " +
            "A plan is sellable once.",
    });
  } catch (err) {
    sessions.setState(session.id, "failed", { error: String(err.message ?? err) });
    return c.json({ error: String(err.message ?? err), planId: session.id }, 502);
  }
});

/**
 * Argue with the plan before paying for it.
 *
 * A brief rarely survives first contact: the requester wants it shorter, or a
 * different angle, or scene three replaced. Each revision re-plans and re-prices,
 * so the quote always matches the thing being bought rather than the thing
 * originally asked for. Priced like a quote because each turn is real agent work.
 */
app.post("/v1/discuss", async (c) => {
  const id = c.req.query("plan");
  const s = id ? sessions.read(id) : null;
  if (!s?.plan) return c.json({ error: "unknown plan" }, 404);
  if (s.state !== "quoted") {
    return c.json({ error: `plan is ${s.state} and can no longer be revised` }, 409);
  }
  const b = await body(c);
  if (!b?.message) return c.json({ error: "message is required" }, 400);

  const conversation = [...(s.conversation ?? []), { from: "requester", text: b.message }];
  try {
    const revised = await draftPlan({
      sessionId: id,
      brief: s.task.brief,
      style: s.task.style,
      attachments: s.attachments ?? [],
      conversation,
      previous: s.plan,
      maxScenes: Number(b.maxScenes ?? 6),
    });
    if (!revised) return c.json({ error: "could not revise the plan" }, 502);

    const pricing = priceJob(revised);
    sessions.update(id, (t) => {
      t.plan = { ...revised, pricing, budgetTinybar: budgetFor(pricing) };
      t.conversation = [...conversation, {
        from: "studio",
        text: `Revised: ${revised.scenes.length} scenes, ${prism(pricing.quoteUnits)} PRISM.`,
      }];
      return t;
    });
    return c.json({
      planId: id,
      revised: true,
      plan: summarise(revised),
      quote: { units: pricing.quoteUnits, prism: prism(pricing.quoteUnits), asset: PRISM },
      buy: `POST ${ORIGIN}/v1/render?plan=${id}`,
    });
  } catch (err) {
    return c.json({ error: String(err.message ?? err) }, 502);
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
  return c.json(await buildReceipt(s, { origin: ORIGIN, token: PRISM }));
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
  c.json({ ok: true, asset: PRISM, payTo: PAY_TO, facilitator: FACILITATOR_URL }));

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
  console.log(`  sells    PRISM ${PRISM} -> payTo ${PAY_TO}`);
  console.log(`  paid     POST /v1/quote 0.05 ℏ    POST /v1/render <quoted> PRISM`);
  console.log(`  free     GET /v1/job/:id  /v1/receipt/:id  /v1/download/:id  /health`);
});
