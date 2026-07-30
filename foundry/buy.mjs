/**
 * A buyer for the foundry: pay an x402 route in HBAR and keep what comes back.
 *
 * This is the studio's side of a supplier purchase, reduced to the smallest
 * honest thing: read the 402, build the transfer the `exact` scheme asks for,
 * sign it, retry with the payment, and write the asset to disk. No threshold
 * key here, because that guard belongs to the agent that spends unattended; a
 * one-shot purchase run by a human does not need a co-signer to protect it from
 * itself.
 *
 *   node foundry/buy.mjs image  "a prism on a dark desk"
 *   node foundry/buy.mjs speech "one payment, three payees"
 *   node foundry/buy.mjs music  "sparse ambient pads"
 */
import { mkdirSync, writeFileSync } from "node:fs";
import "dotenv/config";
import {
  AccountId, Client, Hbar, PrivateKey, TransactionId, TransferTransaction,
} from "@hiero-ledger/sdk";

const ORIGIN = process.env.FOUNDRY_ORIGIN ?? "http://localhost:4061";
const BUYER_ID = process.env.BUYER_ID;
const BUYER_KEY = process.env.BUYER_KEY;
if (!BUYER_ID || !BUYER_KEY) {
  console.error("BUYER_ID and BUYER_KEY are required. Run `node foundry/new-buyer.mjs` first.");
  process.exit(1);
}

const [kind, ...rest] = process.argv.slice(2);
const prompt = rest.join(" ");
const SKU = {
  image:  { path: "/v1/image",  body: { prompt }, ext: "jpg" },
  speech: { path: "/v1/speech", body: { text: prompt }, ext: "wav" },
  music:  { path: "/v1/music",  body: { prompt }, ext: "mp3" },
}[kind];
if (!SKU || !prompt) {
  console.error("usage: node foundry/buy.mjs <image|speech|music> <prompt>");
  process.exit(1);
}

const decode = (b64) => JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64");
const post = (extra = {}) =>
  fetch(`${ORIGIN}${SKU.path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...extra },
    body: JSON.stringify(SKU.body),
  });

const key = PrivateKey.fromStringECDSA(BUYER_KEY.replace(/^0x/, ""));
const client = Client.forTestnet().setOperator(AccountId.fromString(BUYER_ID), key);

const before = await fetch(`${process.env.MIRROR_NODE_URL}/api/v1/accounts/${BUYER_ID}`)
  .then((r) => r.json()).then((d) => Number(d.balance?.balance ?? 0));

try {
  console.log(`buyer  ${BUYER_ID}  holding ${(before / 1e8).toFixed(4)} ℏ`);
  console.log(`POST   ${ORIGIN}${SKU.path}\n`);

  // ---- 1. the challenge -----------------------------------------------
  const first = await post();
  if (first.status !== 402) {
    console.log(`expected 402, got ${first.status}: ${(await first.text()).slice(0, 300)}`);
    process.exit(1);
  }
  const challenge = decode(first.headers.get("payment-required"));
  const accepted = challenge.accepts[0];
  console.log(`402    ${accepted.amount} tinybar of ${accepted.asset} → ${accepted.payTo}`);
  console.log(`       feePayer ${accepted.extra.feePayer} sponsors the network fee`);

  // ---- 2. the transfer the exact scheme wants --------------------------
  const amount = BigInt(accepted.amount);
  const tx = new TransferTransaction()
    .addHbarTransfer(AccountId.fromString(BUYER_ID), Hbar.fromTinybars(-amount))
    .addHbarTransfer(AccountId.fromString(accepted.payTo), Hbar.fromTinybars(amount))
    // Naming the facilitator as transaction payer is what makes it sponsor fees.
    .setTransactionId(TransactionId.generate(AccountId.fromString(accepted.extra.feePayer)));
  tx.freezeWith(client);
  const signed = await tx.sign(key);
  console.log(`       signed by the buyer, fee payer's signature still missing`);

  // ---- 3. retry with the payment ---------------------------------------
  const paid = await post({
    "payment-signature": encode({
      x402Version: 2,
      resource: challenge.resource,
      accepted,
      payload: { transaction: Buffer.from(signed.toBytes()).toString("base64") },
    }),
  });

  console.log(`\n${paid.status}    ${paid.status === 200 ? "paid and served" : "failed"}`);
  const settle = paid.headers.get("payment-response");
  if (settle) {
    const s = decode(settle);
    const mirrorId = String(s.transaction).replace("@", "-").replace(/\.(\d+)$/, "-$1");
    console.log(`       tx    ${s.transaction}`);
    console.log(`       payer ${s.payer}`);
    console.log(`       https://hashscan.io/testnet/transaction/${mirrorId}`);
  }
  if (paid.status !== 200) {
    console.log((await paid.text()).slice(0, 400));
    process.exit(1);
  }

  const out = await paid.json();
  mkdirSync("out", { recursive: true });
  const file = `out/${kind}-${Date.now()}.${SKU.ext}`;
  writeFileSync(file, Buffer.from(out.data, "base64"));
  console.log(`\n       got   ${out.bytes} bytes of ${out.contentType}`);
  if (out.seconds) console.log(`       length ${out.seconds}s`);
  if (out.upstreamCostUsd != null) console.log(`       the seller's own cost was $${out.upstreamCostUsd}`);
  console.log(`       wrote ${file}`);

  // The mirror node trails consensus by a beat, so reading the balance the
  // instant the 200 lands reports no change at all and makes a settled payment
  // look free. Wait for it to move rather than printing a number that is only
  // true for another second.
  let after = before;
  for (let i = 0; i < 10 && after === before; i++) {
    await new Promise((r) => setTimeout(r, 1200));
    after = await fetch(`${process.env.MIRROR_NODE_URL}/api/v1/accounts/${BUYER_ID}`)
      .then((r) => r.json()).then((d) => Number(d.balance?.balance ?? 0)).catch(() => before);
  }
  console.log(`\n       buyer paid ${((before - after) / 1e8).toFixed(8)} ℏ in total`);
  console.log(`       quoted     ${(Number(amount) / 1e8).toFixed(8)} ℏ, and the network fee was sponsored`);
} catch (err) {
  console.error(`\nbuy failed: ${err?.message ?? err}`);
  process.exitCode = 1;
} finally {
  client.close();
}
