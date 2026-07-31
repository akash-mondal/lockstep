/**
 * On-chain acceptance test.
 *
 * Starts nothing and mocks nothing. It drives a real x402 payment through the
 * running services to a public facilitator, then re-derives every claim from
 * public mirror-node data rather than from anything the services told us. If
 * this passes, the money path works.
 *
 *   npm run foundry     # in another shell
 *   npm run studio      # in another shell
 *   npm run verify
 *
 * What it cannot prove is off-chain: key custody, and that the co-signer's half
 * really is out of the agent's reach. Those rest on reading the code.
 */
import "dotenv/config";
import { AccountId, Client, Hbar, PrivateKey, TransactionId, TransferTransaction } from "@hiero-ledger/sdk";

const MIRROR = process.env.MIRROR_NODE_URL ?? "https://testnet.mirrornode.hedera.com";
const FOUNDRY = process.env.FOUNDRY_ORIGIN ?? "http://localhost:4061";
const STUDIO = process.env.STUDIO_ORIGIN ?? "http://localhost:4071";
const HBAR = "0.0.0";

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  ok ? passed++ : failed++;
  return ok;
};

const dec = (b64) => JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const toMirrorId = (id) => String(id).replace("@", "-").replace(/\.(\d+)$/, "-$1");

/** Poll the mirror node: a record is not queryable the instant it reaches consensus. */
async function record(txId, attempts = 10) {
  for (let i = 0; i < attempts; i++) {
    const r = await fetch(`${MIRROR}/api/v1/transactions/${toMirrorId(txId)}`).catch(() => null);
    if (r?.ok) {
      const j = await r.json();
      if (j.transactions?.length) return j.transactions[0];
    }
    await new Promise((s) => setTimeout(s, 1500));
  }
  return null;
}

const reachable = async (url) => (await fetch(url).catch(() => null)) !== null;

console.log("\nLOCKSTEP  on-chain acceptance test\n" + "=".repeat(64));

if (!(await reachable(`${FOUNDRY}/health`)) || !(await reachable(`${STUDIO}/`))) {
  console.error(
    `\n  Services unreachable.\n` +
      `    foundry  ${FOUNDRY}   npm run foundry\n` +
      `    studio   ${STUDIO}   npm run studio\n`,
  );
  process.exit(1);
}

const buyerId = process.env.BUYER_ID;
const buyerKey = PrivateKey.fromStringECDSA(String(process.env.BUYER_KEY).replace(/^0x/, ""));
const client = Client.forTestnet().setOperator(AccountId.fromString(buyerId), buyerKey);

const payload = { prompt: "a machined brass key on dark steel, studio light", seed: 7 };

try {
  // ---- 1. A paid route refuses, and says what it costs -------------------
  console.log("\n[1] An unpaid request is refused, and quotes its price");
  const unpaid = await fetch(`${FOUNDRY}/v1/image`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  check("returns 402", unpaid.status === 402, `got ${unpaid.status}`);

  const challenge = dec(unpaid.headers.get("payment-required"));
  const accepted = challenge.accepts[0];
  check("quotes native HBAR", accepted.asset === HBAR, `asset ${accepted.asset}`);
  check("names a fee payer", Boolean(accepted.extra?.feePayer), accepted.extra?.feePayer ?? "");
  check(
    "scheme is exact on hedera:testnet",
    accepted.scheme === "exact" && accepted.network === "hedera:testnet",
  );

  // ---- 2. Pay it for real ------------------------------------------------
  console.log("\n[2] The payment settles through an unmodified public facilitator");
  const amount = BigInt(accepted.amount);
  const tx = new TransferTransaction()
    .addHbarTransfer(AccountId.fromString(buyerId), Hbar.fromTinybars(-amount))
    .addHbarTransfer(AccountId.fromString(accepted.payTo), Hbar.fromTinybars(amount))
    // The fee payer is the facilitator, not the buyer. That is the line which
    // makes an agent holding nothing but its budget possible, so it is asserted
    // here rather than assumed.
    .setTransactionId(TransactionId.generate(AccountId.fromString(accepted.extra.feePayer)));
  tx.freezeWith(client);
  const signed = await tx.sign(buyerKey);

  const paid = await fetch(`${FOUNDRY}/v1/image`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "payment-signature": enc({
        x402Version: 2,
        resource: challenge.resource,
        accepted,
        payload: { transaction: Buffer.from(signed.toBytes()).toString("base64") },
      }),
    },
    body: JSON.stringify(payload),
  });
  check("the paid request succeeds", paid.status === 200, `got ${paid.status}`);

  const body = await paid.json().catch(() => ({}));
  check(
    "an asset comes back",
    typeof body.data === "string" && body.data.length > 1000,
    body.data ? `${Math.round(body.data.length / 1024)} KB` : "no data",
  );

  const settled = dec(paid.headers.get("payment-response"));
  check("a settlement id is returned", Boolean(settled?.transaction), settled?.transaction ?? "");

  // ---- 3. Re-derive every claim from public data -------------------------
  console.log("\n[3] The ledger agrees, read back from the mirror node");
  const rec = await record(settled.transaction);
  if (!check("the transaction is on the public mirror node", Boolean(rec))) {
    throw new Error("the settlement never indexed");
  }
  check("consensus status is SUCCESS", rec.result === "SUCCESS", rec.result);

  const transfers = rec.transfers ?? [];
  const credited = transfers.find((t) => t.account === accepted.payTo);
  check(
    "the seller was credited the quoted amount",
    BigInt(credited?.amount ?? 0) === amount,
    `${credited?.amount} vs ${amount}`,
  );

  const buyerLeg = transfers.find((t) => t.account === buyerId);
  check(
    "the buyer was debited the quoted amount and nothing more",
    BigInt(buyerLeg?.amount ?? 0) === -amount,
    `${buyerLeg?.amount} vs ${-amount}`,
  );

  const feeLeg = transfers.find((t) => t.account === accepted.extra.feePayer);
  check(
    "the facilitator paid the network fee",
    Boolean(feeLeg) && BigInt(feeLeg.amount) < 0n,
    feeLeg ? String(feeLeg.amount) : "no leg",
  );

  check("no token moved; this settled in HBAR alone", (rec.token_transfers ?? []).length === 0);

  // ---- 4. The studio will not sell work nobody planned -------------------
  console.log("\n[4] The studio refuses to sell a render nobody has planned");
  const unplanned = await fetch(`${STUDIO}/v1/render?plan=does-not-exist`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  check(
    "an unknown plan cannot be bought",
    unplanned.status === 402 || unplanned.status === 404,
    `got ${unplanned.status}`,
  );

  if (unplanned.status === 402) {
    // The price callback expresses refusal as a number nobody will pay, because
    // the scheme gives a 402 no way to say "not for sale".
    const refusal = dec(unplanned.headers.get("payment-required"));
    check(
      "refusal is priced out of reach",
      BigInt(refusal.accepts[0].amount) > 10_000_000_000n,
      `${refusal.accepts[0].amount} tinybar`,
    );
  }
} finally {
  client.close();
}

console.log("\n" + "=".repeat(64));
console.log(`  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
