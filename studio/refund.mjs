/**
 * Returning a buyer's money when the studio failed to deliver.
 *
 * x402 `exact` settles before the work starts, so a job that dies leaves the
 * buyer paid up for nothing. The scheme has no refund path and is not going to
 * grow one: the payment already reached consensus, and there is nothing to
 * reverse. What is left is the ordinary thing a business does, which is to send
 * the money back and say so.
 *
 * Two decisions here are deliberate.
 *
 * The payee is read off the ledger, never from the session. The account to repay
 * is whichever account the mirror node says actually funded the inbound payment,
 * because a refund addressed from stored state is a refund that can be aimed
 * somewhere else by whatever wrote that state.
 *
 * The full amount goes back, not the amount minus what was already spent. The
 * assets bought on the way are the studio's loss. Charging a buyer for materials
 * consumed by a job that produced nothing is how a supplier turns its own
 * failure into a bill.
 */
import { readFileSync } from "node:fs";
import "dotenv/config";
import {
  AccountId, Client, Hbar, PrivateKey, TransferTransaction,
} from "@hiero-ledger/sdk";
import * as sessions from "./sessions.mjs";
import { transaction, toMirrorTxId, hashscanTx } from "../lockstep/mirror.mjs";

const state = JSON.parse(readFileSync(new URL("../.state.json", import.meta.url), "utf8"));

/**
 * The account sales are paid into. This is what refunds come out of, because it
 * is what the money went into; the spending wallet never held it.
 */
function till() {
  const id = process.env.STUDIO_PAYTO_ID ?? state.studio?.studio?.id;
  const key = process.env.STUDIO_PAYTO_KEY ?? state.studio?.studio?.key;
  if (!id || !key) throw new Error("no key for the account sales are paid into; cannot refund");
  return { id, key: PrivateKey.fromStringECDSA(String(key).replace(/^0x/, "")) };
}

/**
 * Send back everything a buyer paid for a job that produced nothing.
 *
 * Never throws. A failing refund must not replace a job's real error with its
 * own, so the outcome is recorded on the session either way and the caller
 * decides what to do about it.
 *
 * @returns {Promise<object|null>} the refund record, or null if there was
 *   nothing to refund
 */
export async function refund(sessionId, reason) {
  const session = sessions.read(sessionId);
  if (!session) return null;
  if (session.refund?.settled) return session.refund;

  const inboundId = session.funding?.transactionId;
  if (!inboundId) {
    // Nothing was ever recorded as received, so there is nothing to send back.
    // This is the honest outcome for a job that failed before it was paid for.
    return null;
  }

  let client = null;
  try {
    const mirrorId = toMirrorTxId(inboundId);
    const record = await transaction(mirrorId, { attempts: 10, delayMs: 1500 });
    if (!record) throw new Error(`the inbound payment ${mirrorId} is not indexed yet`);

    // The payer is the largest debit in the transfer list. The facilitator's own
    // leg is in there too as the network fee, and it is much smaller.
    const debits = (record.transfers ?? []).filter((t) => BigInt(t.amount) < 0n);
    const payer = debits.sort((a, b) => Number(BigInt(a.amount) - BigInt(b.amount)))[0];
    if (!payer) throw new Error("the inbound record has no debit to refund");
    const amount = -BigInt(payer.amount);
    if (amount <= 0n) throw new Error("the inbound record refunds to nothing");

    const from = till();
    client = Client.forTestnet().setOperator(
      AccountId.fromString(from.id), from.key,
    );

    // The studio pays this network fee itself. Asking a facilitator to sponsor
    // the apology would be charging someone else for our own failure.
    const tx = await new TransferTransaction()
      .addHbarTransfer(AccountId.fromString(from.id), Hbar.fromTinybars(-amount))
      .addHbarTransfer(AccountId.fromString(payer.account), Hbar.fromTinybars(amount))
      .setTransactionMemo(`lockstep refund ${sessionId}`.slice(0, 100))
      .execute(client);
    const receipt = await tx.getReceipt(client);
    if (receipt.status.toString() !== "SUCCESS") {
      throw new Error(`refund transfer returned ${receipt.status.toString()}`);
    }

    const txId = tx.transactionId.toString();
    const done = {
      settled: true,
      to: payer.account,
      from: from.id,
      amount: String(amount),
      transactionId: txId,
      hashscan: hashscanTx(toMirrorTxId(txId)),
      reason: reason ?? session.error ?? "the job produced no artifact",
      at: Date.now(),
    };
    sessions.update(sessionId, (s) => { s.refund = done; return s; });
    return done;
  } catch (err) {
    // Record the attempt. An unpaid debt that nobody wrote down is worse than
    // one that is visible on the receipt with the reason it is still open.
    const failed = {
      settled: false,
      error: String(err?.message ?? err),
      reason: reason ?? session.error ?? "the job produced no artifact",
      at: Date.now(),
    };
    sessions.update(sessionId, (s) => { s.refund = failed; return s; });
    return failed;
  } finally {
    client?.close();
  }
}
