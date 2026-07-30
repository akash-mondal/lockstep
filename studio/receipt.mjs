/**
 * The bill: what the buyer paid, and what that paid for.
 *
 * This is the part of Prism Studio that does not exist anywhere else. Plenty of
 * systems can show an agent paying for something. A receipt that decomposes into
 * the supply chain that produced the work, with every line checkable on a public
 * ledger by someone who does not trust us, is what the mechanism is actually
 * for.
 *
 * It has two halves and they are different kinds of thing:
 *
 *   inbound   one payment, divided at consensus among the value chain. The
 *             division is read from `assessed_custom_fees` on the transaction
 *             record, not from our own accounting.
 *   outbound  every asset the agent bought to make the video, each its own x402
 *             settlement in HBAR, each naming what it bought.
 *
 * Nothing here is asserted. Every figure comes back from the mirror node, and
 * every line carries the link that lets a reader check it.
 */
import { transaction, hashscanTx, toMirrorTxId } from "../prism/mirror.mjs";

const tinybar = (n) => Number(BigInt(n ?? 0)) / 1e8;
const fmt = (n) => tinybar(n).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");

/**
 * Look up what the network actually assessed on the inbound payment.
 *
 * Deliberately not reconstructed from the fee schedule: the schedule says what
 * *should* happen, the record says what did. If those ever disagree, the receipt
 * should show the disagreement rather than paper over it.
 */
async function inboundFrom(txId, { labels }) {
  if (!txId) return null;
  const mirrorId = toMirrorTxId(txId);
  const record = await transaction(mirrorId, { attempts: 8, delayMs: 1200 });
  if (!record) {
    return { transactionId: mirrorId, hashscan: hashscanTx(mirrorId), indexed: false };
  }
  const transfers = record.token_transfers ?? [];
  const assessed = record.assessed_custom_fees ?? [];
  const collectors = new Set(assessed.map((f) => f.collector_account_id));
  const debits = transfers.filter((t) => BigInt(t.amount) < 0n);
  const gross = -debits.reduce((s, t) => s + BigInt(t.amount), 0n);

  const shares = [
    ...transfers
      .filter((t) => BigInt(t.amount) > 0n && !collectors.has(t.account))
      .map((t) => ({
        role: labels[t.account] ?? "studio",
        account: t.account,
        amount: String(t.amount),
        hbar: fmt(t.amount),
        via: "payTo",
      })),
    ...assessed.map((f) => ({
      role: labels[f.collector_account_id] ?? "collector",
      account: f.collector_account_id,
      amount: String(f.amount),
      hbar: fmt(f.amount),
      via: "assessed_custom_fee",
    })),
  ];

  return {
    transactionId: mirrorId,
    hashscan: hashscanTx(mirrorId),
    indexed: true,
    consensusTimestamp: record.consensus_timestamp,
    paidBy: debits[0]?.account ?? null,
    gross: String(gross),
    grossHbar: fmt(gross),
    dividedInto: shares,
    // The claim worth checking: the buyer signed one transfer to one account.
    note:
      "The buyer signed a transfer crediting one account the full amount and naming " +
      "no collector. The division below was performed by consensus nodes inside the " +
      "same transaction.",
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

export async function buildReceipt(session, { origin, token }) {
  const labels = {
    [session.plan?.parties?.studio]: "studio",
    [session.plan?.parties?.upstream]: "upstream",
    [session.plan?.parties?.referrer]: "referrer",
  };
  const inbound = await inboundFrom(session.funding?.transactionId, { labels });
  const outbound = outboundFrom(session.ledger ?? []);
  const spent = outbound.reduce((s, o) => s + BigInt(o.amount), 0n);

  return {
    jobId: session.id,
    title: session.plan?.title ?? null,
    state: session.state,
    asset: token,

    inbound,
    outbound,

    totals: {
      received: inbound?.gross ?? null,
      receivedHbar: inbound ? fmt(inbound.gross) : null,
      spentOnAssets: String(spent),
      spentOnAssetsHbar: fmt(spent),
      purchases: outbound.length,
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
    L.push(`## You paid ${receipt.inbound.grossHbar}`, "");
    L.push(`[\`${receipt.inbound.transactionId}\`](${receipt.inbound.hashscan})`, "");
    L.push(`One transfer. The network divided it:`, "");
    L.push(`| party | share | account |`, `|---|---|---|`);
    for (const s of receipt.inbound.dividedInto) {
      L.push(`| ${s.role} | ${s.hbar} | \`${s.account}\` |`);
    }
    L.push("");
  }
  if (receipt.outbound.length) {
    L.push(`## What it bought`, "");
    L.push(`| asset | cost | settlement |`, `|---|---|---|`);
    for (const o of receipt.outbound) {
      L.push(`| ${o.what} | ${o.hbar} | ${o.hashscan ? `[check](${o.hashscan})` : "—"} |`);
    }
    L.push("", `${receipt.totals.purchases} purchases, ${receipt.totals.spentOnAssetsHbar} total.`, "");
  }
  const video = receipt.artifacts.find((a) => a.url);
  if (video) L.push(`## The video`, "", `[${video.name}](${video.url}) · ${video.bytes} bytes`, "");
  return L.join("\n");
}
