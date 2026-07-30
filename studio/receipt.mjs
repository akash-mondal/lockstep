/**
 * The bill: what the buyer paid, and what that paid for.
 *
 * This is the part that does not exist elsewhere. Plenty of systems can show an
 * agent paying for something. A receipt that decomposes into the purchases that
 * produced the work, every line checkable on a public ledger by someone who does
 * not trust us, is the point.
 *
 *   inbound   what the buyer paid, in HBAR, read back from the record
 *   outbound  every asset the agent bought to make the video, each its own x402
 *             settlement, each naming what it bought
 *
 * Nothing here is asserted. Every figure comes back from the mirror node, and
 * every line carries the link that lets a reader check it.
 */
import { transaction, hashscanTx, toMirrorTxId } from "../lockstep/mirror.mjs";

const tinybar = (n) => Number(BigInt(n ?? 0)) / 1e8;
const fmt = (n) => tinybar(n).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");

/**
 * Look up what the network actually assessed on the inbound payment.
 *
 * Deliberately not reconstructed from the fee schedule: the schedule says what
 * *should* happen, the record says what did. If those ever disagree, the receipt
 * should show the disagreement rather than paper over it.
 */
async function inboundFrom(txId) {
  if (!txId) return null;
  const mirrorId = toMirrorTxId(txId);
  const record = await transaction(mirrorId, { attempts: 8, delayMs: 1200 });
  if (!record) {
    return { transactionId: mirrorId, hashscan: hashscanTx(mirrorId), indexed: false };
  }
  // Only the movements this payment caused. The node and network fee entries in
  // a Hedera record are real but are not what the buyer paid the studio, and
  // showing them as such would overstate the bill.
  const transfers = record.transfers ?? [];
  const debits = transfers.filter((t) => BigInt(t.amount) < 0n);
  const paidBy = debits.sort((a, b) => Number(BigInt(a.amount) - BigInt(b.amount)))[0];
  const gross = paidBy ? -BigInt(paidBy.amount) : 0n;
  const credited = transfers
    .filter((t) => BigInt(t.amount) > 0n && BigInt(t.amount) === gross)
    .map((t) => t.account);

  return {
    transactionId: mirrorId,
    hashscan: hashscanTx(mirrorId),
    indexed: true,
    consensusTimestamp: record.consensus_timestamp,
    asset: "0.0.0",
    paidBy: paidBy?.account ?? null,
    paidTo: credited[0] ?? null,
    gross: String(gross),
    grossHbar: fmt(gross),
    // The buyer paid no network fee. That is the fee-payer model, not a rounding
    // detail, and it is why an agent can hold nothing but what it means to spend.
    networkFeePaidBy: record.transfers?.length ? "the facilitator, as transaction fee payer" : null,
  };
}

/** Every purchase the agent made, in the order it made them. */
function outboundFrom(ledger) {
  return ledger.map((e) => ({
    what: e.what,
    sku: e.sku,
    amount: String(e.tinybar),
    hbar: fmt(e.tinybar),
    asset: e.asset ?? "0.0.0",
    transactionId: e.transactionId ?? null,
    hashscan: e.transactionId ? hashscanTx(toMirrorTxId(e.transactionId)) : null,
    at: e.at,
  }));
}

export async function buildReceipt(session, { origin, asset = "0.0.0" }) {
  const inbound = await inboundFrom(session.funding?.transactionId);
  const outbound = outboundFrom(session.ledger ?? []);
  const spent = outbound.reduce((s, o) => s + BigInt(o.amount), 0n);

  return {
    jobId: session.id,
    title: session.plan?.title ?? null,
    state: session.state,
    asset,

    inbound,
    outbound,

    totals: {
      received: inbound?.gross ?? null,
      receivedHbar: inbound ? fmt(inbound.gross) : null,
      spentOnAssets: String(spent),
      spentOnAssetsHbar: fmt(spent),
      purchases: outbound.length,
      // What the studio kept for planning, composing, rendering and reviewing.
      // Reported rather than inferred, because a margin you have to work out
      // from two other numbers is a margin somebody is hoping you will not.
      makingCharge: inbound ? String(BigInt(inbound.gross) - spent) : null,
      makingChargeHbar: inbound ? fmt(BigInt(inbound.gross) - spent) : null,
      unspentBudgetHbar: session.settlement ? fmt(session.settlement.unspentTinybar) : null,
    },

    artifacts: (session.artifacts ?? []).map((a) => ({
      name: a.name,
      bytes: a.bytes,
      sha256: a.sha256,
      url: a.name.endsWith(".mp4")
        ? `${origin}/v1/download/${session.id}?token=${session.downloadToken}`
        : null,
    })),

    verify: {
      how:
        "Every line above is a public record. Fetch the transaction from the mirror " +
        "node and compare. Nothing here needs our cooperation.",
      mirror: "https://testnet.mirrornode.hedera.com/api/v1/transactions/{id}",
      scope:
        "This accounts for money moved and files produced. It does not attest to " +
        "the quality of the video, nor to who controls the payee accounts.",
    },
  };
}

/** The same thing as prose, for an agent that has to show a human. */
export function renderMarkdown(receipt) {
  const L = [];
  L.push(`# ${receipt.title ?? "Video"}`, "");
  if (receipt.inbound?.indexed) {
    L.push(`## You paid ${receipt.inbound.grossHbar} HBAR`, "");
    L.push(`[\`${receipt.inbound.transactionId}\`](${receipt.inbound.hashscan})`, "");
    L.push(`You paid no network fee; the facilitator sponsored it.`, "");
  }
  if (receipt.outbound.length) {
    L.push(`## What it bought`, "");
    L.push(`| asset | cost | settlement |`, `|---|---|---|`);
    for (const o of receipt.outbound) {
      L.push(`| ${o.what} | ${o.hbar} | ${o.hashscan ? `[check](${o.hashscan})` : "—"} |`);
    }
    L.push("", `${receipt.totals.purchases} purchases, ${receipt.totals.spentOnAssetsHbar} HBAR of inputs.`,
      `Making charge kept by the studio: ${receipt.totals.makingChargeHbar} HBAR.`, "");
  }
  const video = receipt.artifacts.find((a) => a.url);
  if (video) L.push(`## The video`, "", `[${video.name}](${video.url}) · ${video.bytes} bytes`, "");
  return L.join("\n");
}
