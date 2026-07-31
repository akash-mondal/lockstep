/**
 * Buying assets from the foundry, on the studio's own wallet, under a ceiling.
 *
 * Two rules hold this together and both are enforced here rather than asked of
 * the agent:
 *
 *   1. The job has a budget, and a purchase that would exceed it does not
 *      happen. The agent cannot loop, cannot retry its way past the ceiling, and
 *      cannot spend one job's money on another. It is not that the agent is
 *      forbidden to overspend; it is that the code that moves money refuses.
 *   2. Every purchase is recorded against the session before the bytes are
 *      returned, so the receipt is built from what actually settled rather than
 *      from what we meant to buy.
 *
 * The change left over is the point, not an accident. The buyer paid a quote
 * derived from the job's own cost with margin on top; whatever the job did not
 * need stays with the studio, and the receipt says so rather than leaving it to
 * be worked out from two other numbers.
 */
import { readFileSync } from "node:fs";
import "dotenv/config";
import {
  AccountId, Client, Hbar, PrivateKey, TransactionId, TransferTransaction,
} from "@hiero-ledger/sdk";
import * as sessions from "./sessions.mjs";

const state = JSON.parse(readFileSync(new URL("../.state.json", import.meta.url), "utf8"));
const FOUNDRY = process.env.FOUNDRY_ORIGIN ?? "http://127.0.0.1:4061";

const decode = (b64) => JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64");

/** The studio's spending wallet. Distinct from the account that receives sales. */
function wallet() {
  const id = process.env.STUDIO_WALLET_ID;
  const key = process.env.STUDIO_WALLET_KEY;
  if (!id || !key) {
    throw new Error("STUDIO_WALLET_ID and STUDIO_WALLET_KEY are required to buy assets");
  }
  return { id, key: PrivateKey.fromStringECDSA(key.replace(/^0x/, "")) };
}

export class BudgetExceeded extends Error {
  constructor(msg) { super(msg); this.name = "BudgetExceeded"; }
}

/**
 * Spend on behalf of a job, once.
 *
 * @param {string} sessionId
 * @param {string} sku        image | speech | music | transcribe
 * @param {string} what       human description, for the bill
 * @param {object} payload    the foundry request body
 */
export async function buy(sessionId, sku, what, payload) {
  const session = sessions.read(sessionId);
  if (!session) throw new Error(`no session ${sessionId}`);

  const budget = BigInt(session.plan?.budgetTinybar ?? 0);
  const spent = sessions.spent(session);

  const { id: buyerId, key } = wallet();
  const client = Client.forTestnet().setOperator(AccountId.fromString(buyerId), key);
  const route = `/v1/${sku}`;
  const post = (extra = {}) =>
    fetch(`${FOUNDRY}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...extra },
      body: JSON.stringify(payload),
    });

  try {
    const first = await post();
    if (first.status !== 402) {
      throw new Error(`foundry did not ask for payment: ${first.status} ${(await first.text()).slice(0, 200)}`);
    }
    const challenge = decode(first.headers.get("payment-required"));
    const accepted = challenge.accepts[0];
    const amount = BigInt(accepted.amount);

    // The ceiling is checked against the price the seller actually quoted, not
    // against a table we hold. A seller that raises its price mid-job cannot
    // walk a agent past its budget.
    if (spent + amount > budget) {
      throw new BudgetExceeded(
        `${what} costs ${Number(amount) / 1e8} but only ` +
        `${Number(budget - spent) / 1e8} of the job's budget remains`,
      );
    }

    const tx = new TransferTransaction()
      .addHbarTransfer(AccountId.fromString(buyerId), Hbar.fromTinybars(-amount))
      .addHbarTransfer(AccountId.fromString(accepted.payTo), Hbar.fromTinybars(amount))
      .setTransactionId(TransactionId.generate(AccountId.fromString(accepted.extra.feePayer)));
    tx.freezeWith(client);
    const signed = await tx.sign(key);

    const paid = await post({
      "payment-signature": encode({
        x402Version: 2,
        resource: challenge.resource,
        accepted,
        payload: { transaction: Buffer.from(signed.toBytes()).toString("base64") },
      }),
    });
    if (paid.status !== 200) {
      throw new Error(`${what} failed: ${paid.status} ${(await paid.text()).slice(0, 200)}`);
    }

    const settle = paid.headers.get("payment-response");
    const transactionId = settle ? decode(settle).transaction : null;
    const out = await paid.json();

    sessions.addPayment(sessionId, {
      sku, what, tinybar: String(amount), asset: "0.0.0", transactionId,
    });

    // Money moving is the most interesting thing this system does, so it goes
    // on the stream with the settlement id: a watcher can open HashScan and
    // check the payment while the job that made it is still running.
    const spentNow = sessions.spent(sessions.read(sessionId));
    sessions.publish(sessionId, {
      type: "payment",
      sku,
      what,
      tinybar: String(amount),
      hbar: Number(amount) / 1e8,
      transactionId,
      hashscan: transactionId
        ? `https://hashscan.io/testnet/transaction/${String(transactionId).replace("@", "-").replace(/\.(\d+)$/, "-$1")}`
        : null,
      spentHbar: Number(spentNow) / 1e8,
      budgetHbar: Number(BigInt(session.plan?.budgetTinybar ?? 0)) / 1e8,
    });
    return out;
  } finally {
    client.close();
  }
}

/** What the job has left to spend, in tinybar. */
export function remaining(session) {
  return BigInt(session.plan?.budgetTinybar ?? 0) - sessions.spent(session);
}

/**
 * What the buyer paid, what the job consumed, and what the studio kept.
 *
 * Reported rather than hidden: a quote with margin in it is only honest if the
 * margin is visible afterwards.
 */
export function settlement(session) {
  const quote = BigInt(session.plan?.pricing?.quoteTinybar ?? 0);
  const budget = BigInt(session.plan?.budgetTinybar ?? 0);
  const spent = sessions.spent(session);
  return {
    quoteTinybar: String(quote),
    budgetTinybar: String(budget),
    spentTinybar: String(spent),
    // What the ceiling allowed and the job did not need. The agent stopping
    // under budget is the design working, not an accident.
    unspentTinybar: String(budget - spent),
    // What the studio kept for planning, composing, rendering and reviewing.
    makingChargeTinybar: String(quote - spent),
  };
}
