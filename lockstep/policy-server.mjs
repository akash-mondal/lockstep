/**
 * The policy co-signer, as an actual separate service.
 *
 * This runs in its own process and is the only thing that reads `.policy.key`.
 * The agent talks to it over HTTP and never touches the second key.
 *
 * That separation is load-bearing. A `KeyList` with threshold 2 gives the account
 * the right shape on-chain no matter how the keys are stored — but if both keys
 * are loadable by the same process, the compromise boundary the design claims does
 * not exist. Running the co-signer in-process would make the ledger evidence real
 * and the security story fictional.
 *
 *   npm run policy    # port 4052
 */
import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { POLICY, requestCosign } from "./policy.mjs";

const PORT = Number(process.env.POLICY_PORT ?? 4052);
const app = new Hono();

/**
 * A shared secret between the agent and its co-signer.
 *
 * Key separation alone is not a boundary if anyone who can reach the port gets
 * signatures on request — the policy caps bound the damage, but an unauthenticated
 * co-signer will happily drain the agent up to those caps for a stranger. Refusing
 * to start without a secret is deliberate: a co-signer that silently ran open would
 * be worse than none, because the design would still claim protection.
 */
const TOKEN = process.env.POLICY_TOKEN;
if (!TOKEN) {
  console.error("POLICY_TOKEN is required — set the same value for the agent and this service.");
  console.error("It is the only thing stopping anyone who can reach this port from getting signatures.");
  process.exit(1);
}

const audit = [];

app.post("/cosign", async (c) => {
  const presented = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (presented !== TOKEN) {
    return c.json({ approved: false, reason: "caller is not an authorized agent" }, 401);
  }
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ approved: false, reason: "malformed request body" }, 400);
  }
  const { transactionBase64, challenge } = body ?? {};
  if (typeof transactionBase64 !== "string" || !challenge) {
    return c.json({ approved: false, reason: "transactionBase64 and challenge are required" }, 400);
  }

  const decision = await requestCosign({ transactionBase64, challenge });
  // Every decision is recorded, refusals included — a guardrail nobody can review
  // is hard to trust.
  audit.push({
    at: new Date().toISOString(),
    approved: decision.approved,
    reason: decision.reason,
    asset: challenge.asset,
    amount: challenge.amount,
    payTo: challenge.payTo,
  });
  if (audit.length > 500) audit.shift();

  return c.json(decision, decision.approved ? 200 : 403);
});

/** The rules, published. A policy you cannot read is not a guarantee. */
app.get("/policy", (c) =>
  c.json({
    maxPerCall: Object.fromEntries(Object.entries(POLICY.maxPerCall).map(([k, v]) => [k, String(v)])),
    allowedPayees: [...POLICY.allowedPayees],
    allowedAssets: [...POLICY.allowedAssets],
    maxCallsPerMinute: POLICY.maxCallsPerMinute,
    enforcement:
      "Hedera KeyList threshold 2. Refusal withholds the second signature, so the payment is impossible rather than disallowed.",
  }),
);

app.get("/decisions", (c) => c.json({ count: audit.length, decisions: audit.slice(-50) }));
app.get("/health", (c) => c.json({ ok: true, role: "policy-cosigner" }));

// Loopback by default. @hono/node-server otherwise binds every interface, which
// would put a signing oracle on the network — the bearer token is the last line of
// defence, not the only one it should need. Override deliberately, never by accident.
const HOST = process.env.POLICY_HOST ?? "127.0.0.1";

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`Lockstep policy co-signer on http://${HOST}:${info.port}`);
  console.log(`  holds the agent's second key; the agent process does not`);
  console.log(`  auth: bearer token required on /cosign`);
  if (HOST !== "127.0.0.1") {
    console.log(`  WARNING: bound to ${HOST}, not loopback — this key is reachable off-host`);
  }
  console.log(`  POST /cosign   GET /policy   GET /decisions   GET /health`);
});
