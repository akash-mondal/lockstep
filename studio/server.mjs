/**
 * Lockstep resource server.
 *
 * A metered API for agents, priced per call and settled in native HBAR. Runs on
 * stock `@x402/hono` + `@x402/hedera` against unmodified public facilitators;
 * needing our own facilitator would prove nothing about the standard.
 *
 * This is the primitive's own demand side. What it exists to exercise is the
 * payer rather than the routes: the account paying for these calls is a
 * threshold-2 KeyList, so every settlement here required both the agent's key
 * and the co-signer's, and the agent could not have made one alone.
 *
 *   /v1/token/:id/cost    what an HTS transfer really costs the recipient
 *   /v1/account/:id/risk  can this counterparty receive what you are about to send
 */
import { readFileSync } from "node:fs";
import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { accountRisk, tokenCost } from "./intel.mjs";

const state = JSON.parse(readFileSync(new URL("../.state.json", import.meta.url), "utf8"));
const PAY_TO = state.lockstep.service.id;
const PORT = Number(process.env.PORT ?? 4051);
const ORIGIN = process.env.PUBLIC_ORIGIN ?? `http://localhost:${PORT}`;
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "https://x402.org/facilitator";

const HBAR = "0.0.0";
// Both routes settle in native HBAR. There is no second asset: a payment asset
// the system mints is a payment asset the system can change the rules of, and
// the whole point of the co-signer is that the limit is not ours to move.
const COST_PRICE_TINYBAR = "800000";  // ~$0.02 of HBAR
const RISK_PRICE_TINYBAR = "300000";

/**
 * The official `bazaar` extension is how discovery indexers learn what a route
 * takes and returns. It wants `info` + `schema`, not a bare object.
 */
const bazaar = ({ queryParams = {}, example, properties, required }) => ({
  info: {
    input: { type: "http", method: "GET", queryParams },
    output: { type: "json", example },
  },
  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      input: {
        type: "object",
        properties: {
          type: { type: "string", const: "http" },
          method: { type: "string", enum: ["GET"] },
          queryParams: { type: "object", properties, required },
        },
        required: ["type", "method"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { type: { type: "string" }, example: { type: "object" } },
        required: ["type"],
      },
    },
    required: ["input"],
  },
});

const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const server = new x402ResourceServer(facilitator);
server.register("hedera:*", new ExactHederaScheme());

const routes = {
  "GET /v1/token/:id/cost": {
    accepts: [
      {
        scheme: "exact",
        network: "hedera:testnet",
        price: { asset: HBAR, amount: COST_PRICE_TINYBAR },
        payTo: PAY_TO,
        maxTimeoutSeconds: 180,
      },
    ],
    description: "True cost of transferring an HTS token: custom fees, who bears them, what the recipient actually lands.",
    mimeType: "application/json",
    serviceName: "Lockstep",
    tags: ["hedera", "hts", "custom-fees", "agent-payments", "counterparty"],
    extensions: {
      bazaar: bazaar({
        queryParams: { amount: "20000" },
        properties: { amount: { type: "string", description: "Optional raw amount to quote fees against" } },
        example: { tokenId: "0.0.429274", symbol: "USDC", hasCustomFees: false, verdict: "clean — the recipient lands exactly the quoted amount" },
      }),
    },
  },
  "GET /v1/account/:id/risk": {
    accepts: [
      {
        scheme: "exact",
        network: "hedera:testnet",
        price: { asset: HBAR, amount: RISK_PRICE_TINYBAR },
        payTo: PAY_TO,
        maxTimeoutSeconds: 180,
      },
    ],
    description: "Counterparty check before paying a Hedera account: can it receive the asset, is it multi-key, is it safe.",
    mimeType: "application/json",
    serviceName: "Lockstep",
    tags: ["hedera", "risk", "agent-payments"],
    extensions: {
      bazaar: bazaar({
        queryParams: { asset: "0.0.9795837" },
        properties: { asset: { type: "string", description: "Asset the counterparty must be able to receive" } },
        example: { accountId: "0.0.9795832", canReceive: true, verdict: "ok-to-pay", flags: [] },
      }),
    },
  },
};

const app = new Hono();

app.use("*", async (c, next) => {
  await next();
  c.header("x-lockstep-asset", HBAR);
});

app.use(paymentMiddleware(routes, server));

// ---------------------------------------------------------------- paid routes

app.get("/v1/token/:id/cost", async (c) => {
  const id = c.req.param("id");
  const amount = c.req.query("amount");
  try {
    return c.json(await tokenCost(id, amount));
  } catch (err) {
    return c.json({ error: String(err.message ?? err) }, 502);
  }
});

app.get("/v1/account/:id/risk", async (c) => {
  const id = c.req.param("id");
  try {
    return c.json(await accountRisk(id, c.req.query("asset")));
  } catch (err) {
    return c.json({ error: String(err.message ?? err) }, 502);
  }
});

app.get("/health", (c) => c.json({ ok: true, asset: HBAR, facilitator: FACILITATOR_URL }));

// --------------------------------------------------------------- discovery
// Both spellings are served on purpose: x402scan's registerFromOrigin fetches
// the extension-less path first and reports noDiscovery if only .json exists.

const discovery = {
  version: 1,
  x402Version: 2,
  name: "Lockstep",
  description: "Counterparty intelligence for paying agents, priced per call and settled in native HBAR.",
  resources: [`${ORIGIN}/v1/token/{id}/cost`, `${ORIGIN}/v1/account/{id}/risk`],
};
app.get("/.well-known/x402", (c) => c.json(discovery));
app.get("/.well-known/x402.json", (c) => c.json(discovery));

app.get("/openapi.json", (c) =>
  c.json({
    openapi: "3.1.0",
    info: { title: "Lockstep", version: "1.0.0", description: discovery.description },
    servers: [{ url: ORIGIN }],
    paths: {
      "/v1/token/{id}/cost": {
        get: {
          summary: "True transfer cost of an HTS token",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "amount", in: "query", required: false, schema: { type: "string" } },
          ],
          "x-payment-info": {
            protocols: ["x402"],
            network: "hedera:testnet",
            asset: HBAR,
            price: { mode: "fixed", currency: "HBAR", amount: "0.008" },
          },
          responses: { 200: { description: "Cost breakdown" }, 402: { description: "Payment Required" } },
        },
      },
      "/v1/account/{id}/risk": {
        get: {
          summary: "Counterparty risk check before paying a Hedera account",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          "x-payment-info": {
            protocols: ["x402"],
            network: "hedera:testnet",
            asset: "0.0.0",
            price: { mode: "fixed", currency: "USD", amount: "0.002" },
          },
          responses: { 200: { description: "Risk profile" }, 402: { description: "Payment Required" } },
        },
      },
    },
  }),
);

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`Lockstep resource server on http://localhost:${info.port}`);
  console.log(`  sells       native HBAR -> payTo ${PAY_TO}`);
  console.log(`  facilitator ${FACILITATOR_URL}`);
  console.log(`  paid        GET /v1/token/:id/cost      0.008 \u210f`);
  console.log(`  paid        GET /v1/account/:id/risk    0.003 \u210f`);
  console.log(`  free        GET /health  /.well-known/x402`);
});
