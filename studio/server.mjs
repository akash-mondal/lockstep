/**
 * Lockstep resource server.
 *
 * A metered API for agents, priced per call, where every payment refracts into
 * three payees at consensus. Runs on stock `@x402/hono` + `@x402/hedera` against
 * unmodified public facilitators — needing our own facilitator would prove nothing
 * about the standard.
 *
 * Two paid routes exist deliberately:
 *   /v1/token/:id/cost   settles in PRSM  → the split is on
 *   /v1/account/:id/risk settles in HBAR  → the split is off
 * Same server, same middleware, same facilitator. The only difference is the
 * asset, which is the cleanest way to show what the token's fee schedule adds.
 */
import { readFileSync } from "node:fs";
import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { lockstepExtension } from "../lockstep/extension.mjs";
import { auditSettlement } from "../lockstep/audit.mjs";
import { accountRisk, tokenCost } from "./intel.mjs";
import { readSplit } from "../lockstep/mirror.mjs";

const state = JSON.parse(readFileSync(new URL("../.state.json", import.meta.url), "utf8"));
const TOKEN = state.lockstep.tokenId;
const PAY_TO = state.lockstep.service.id;
const DECIMALS = 6;
const PORT = Number(process.env.PORT ?? 4051);
const ORIGIN = process.env.PUBLIC_ORIGIN ?? `http://localhost:${PORT}`;
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "https://x402.org/facilitator";

// $0.02 — the median x402 price, so this reads as a real service rather than a toy.
const PRICE_UNITS = String(0.02 * 10 ** DECIMALS);
const HBAR_PRICE_TINYBAR = "300000"; // ~$0.002 of HBAR for the control route

const LABELS = {
  [state.lockstep.upstream.id]: "upstream-data",
  [state.lockstep.referrer.id]: "referrer",
};

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
server.registerExtension(lockstepExtension({ tokenId: TOKEN, labels: LABELS }));

const routes = {
  "GET /v1/token/:id/cost": {
    accepts: [
      {
        scheme: "exact",
        network: "hedera:testnet",
        // AssetAmount price — settle in PRSM, whose fee schedule carries the split.
        price: { asset: TOKEN, amount: PRICE_UNITS },
        payTo: PAY_TO,
        maxTimeoutSeconds: 180,
      },
    ],
    description: "True cost of transferring an HTS token: custom fees, who bears them, what the recipient actually lands.",
    mimeType: "application/json",
    serviceName: "Lockstep",
    tags: ["hedera", "hts", "custom-fees", "agent-payments", "counterparty"],
    extensions: {
      lockstep: {},
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
        // Native HBAR — the control route. Same server, same facilitator, no split.
        price: { asset: "0.0.0", amount: HBAR_PRICE_TINYBAR },
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
  c.header("x-lockstep-asset", TOKEN);
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

// --------------------------------------------------------------- free routes
// Audit is deliberately free and keyless: charging for the ability to check us
// would defeat the point.

app.get("/v1/audit/:txId", async (c) => {
  const result = await auditSettlement(c.req.param("txId"), { tokenId: TOKEN, payTo: PAY_TO, labels: LABELS });
  return c.json(result, result.ok === false && result.reason === "not_indexed" ? 202 : 200);
});

app.get("/v1/split", async (c) => {
  const split = await readSplit(TOKEN);
  return c.json({
    ...split,
    payees: [
      { role: "service", basisPoints: split.payToBasisPoints, account: PAY_TO, via: "payTo" },
      ...split.shares.map((s) => ({
        role: LABELS[s.collector] ?? "collector",
        basisPoints: s.basisPoints,
        account: s.collector,
        via: "assessed_custom_fee",
      })),
    ],
    note: "Read live from the token's fee schedule on the public mirror node, not from server config.",
  });
});

app.get("/health", (c) => c.json({ ok: true, asset: TOKEN, facilitator: FACILITATOR_URL }));

// --------------------------------------------------------------- discovery
// Both spellings are served on purpose: x402scan's registerFromOrigin fetches
// the extension-less path first and reports noDiscovery if only .json exists.

const discovery = {
  version: 1,
  x402Version: 2,
  name: "Lockstep",
  description: "Counterparty intelligence for paying agents. Every payment refracts to its supply chain at consensus.",
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
            asset: TOKEN,
            price: { mode: "fixed", currency: "USD", amount: "0.02" },
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
  console.log(`  asset       ${TOKEN} (PRSM)   payTo ${PAY_TO}`);
  console.log(`  facilitator ${FACILITATOR_URL}`);
  console.log(`  paid        GET /v1/token/:id/cost      $0.02 in PRSM  (split ON)`);
  console.log(`  paid        GET /v1/account/:id/risk    HBAR           (split OFF, control)`);
  console.log(`  free        GET /v1/split  /v1/audit/:txId  /health  /.well-known/x402`);
});
