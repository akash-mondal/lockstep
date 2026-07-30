/**
 * Adversarial tests for the policy co-signer.
 *
 * The co-signer exists to defend against a compromised agent. A compromised agent
 * controls the summary it hands the policy service, so every one of these attacks
 * presents a *plausible* challenge alongside a *malicious* transaction. The whole
 * defence rests on the policy deciding against the bytes rather than the story.
 *
 * The redirect case below was a live hole found by writing this file: the policy
 * originally allowlisted `challenge.payTo` without checking who the transaction
 * actually credited, so a benign-looking challenge could carry a transfer to any
 * account at all.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import {
  AccountId,
  Client,
  Hbar,
  NftId,
  PrivateKey,
  TokenId,
  TransactionId,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { requestCosign } from "../prism/policy.mjs";

const state = JSON.parse(readFileSync(new URL("../.state.json", import.meta.url), "utf8"));
const client = Client.forTestnet().setOperator(
  AccountId.fromString(process.env.OPERATOR_ID),
  PrivateKey.fromStringECDSA(process.env.OPERATOR_KEY),
);

const TOKEN = state.prism.tokenId;
const AGENT = state.agent.id;
const SERVICE = state.prism.service.id;
const OUTSIDER = state.seller.id; // a real account that is not allowlisted
const FEE_PAYER = "0.0.9185802";

const honestChallenge = { asset: TOKEN, payTo: SERVICE, amount: "20000" };

/** Freeze and serialize a transfer without signing — policy sees bytes only. */
function build(fn) {
  const tx = new TransferTransaction();
  fn(tx);
  tx.setTransactionId(TransactionId.generate(AccountId.fromString(FEE_PAYER)));
  tx.freezeWith(client);
  return Buffer.from(tx.toBytes()).toString("base64");
}
const token = TokenId.fromString(TOKEN);
const acct = (id) => AccountId.fromString(id);

const cases = [
  {
    name: "honest payment (must be approved)",
    expectApproved: true,
    challenge: honestChallenge,
    tx: build((t) => t.addTokenTransfer(token, acct(AGENT), -20000).addTokenTransfer(token, acct(SERVICE), 20000)),
  },
  {
    name: "redirect: challenge names the service, transaction pays an outsider",
    expectApproved: false,
    challenge: honestChallenge,
    tx: build((t) => t.addTokenTransfer(token, acct(AGENT), -20000).addTokenTransfer(token, acct(OUTSIDER), 20000)),
  },
  {
    name: "skim: pays the service but siphons half to an outsider",
    expectApproved: false,
    challenge: honestChallenge,
    tx: build((t) =>
      t
        .addTokenTransfer(token, acct(AGENT), -20000)
        .addTokenTransfer(token, acct(SERVICE), 10000)
        .addTokenTransfer(token, acct(OUTSIDER), 10000),
    ),
  },
  {
    name: "overspend: debits more than the challenge quoted",
    expectApproved: false,
    challenge: honestChallenge,
    tx: build((t) => t.addTokenTransfer(token, acct(AGENT), -40000).addTokenTransfer(token, acct(SERVICE), 40000)),
  },
  {
    name: "cap breach: amount above the per-call ceiling",
    expectApproved: false,
    challenge: { ...honestChallenge, amount: "999999" },
    tx: build((t) => t.addTokenTransfer(token, acct(AGENT), -999999).addTokenTransfer(token, acct(SERVICE), 999999)),
  },
  {
    name: "smuggled HBAR alongside a token payment",
    expectApproved: false,
    challenge: honestChallenge,
    tx: build((t) =>
      t
        .addTokenTransfer(token, acct(AGENT), -20000)
        .addTokenTransfer(token, acct(SERVICE), 20000)
        .addHbarTransfer(acct(AGENT), Hbar.fromTinybars(-100000))
        .addHbarTransfer(acct(OUTSIDER), Hbar.fromTinybars(100000)),
    ),
  },
  {
    name: "unallowlisted payee declared in the challenge",
    expectApproved: false,
    challenge: { ...honestChallenge, payTo: OUTSIDER },
    tx: build((t) => t.addTokenTransfer(token, acct(AGENT), -20000).addTokenTransfer(token, acct(OUTSIDER), 20000)),
  },
  {
    // The fungible payment is flawless; an NFT rides along and leaves with it.
    // Neither the amount checks nor the facilitator's inspector look at NFT maps.
    name: "smuggle: correct payment carrying an NFT transfer out",
    expectApproved: false,
    challenge: honestChallenge,
    tx: build((t) =>
      t
        .addTokenTransfer(token, acct(AGENT), -20000)
        .addTokenTransfer(token, acct(SERVICE), 20000)
        .addNftTransfer(new NftId(TokenId.fromString("0.0.5555"), 1), acct(AGENT), acct(OUTSIDER)),
    ),
  },
  {
    // Spending someone else's allowance rather than the agent's own balance.
    name: "allowance: approved HBAR transfer smuggled in",
    expectApproved: false,
    challenge: { asset: "0.0.0", payTo: SERVICE, amount: "300000" },
    tx: build((t) =>
      t
        .addApprovedHbarTransfer(acct(AGENT), Hbar.fromTinybars(-300000))
        .addHbarTransfer(acct(SERVICE), Hbar.fromTinybars(300000)),
    ),
  },
  {
    name: "garbage payload",
    expectApproved: false,
    challenge: honestChallenge,
    tx: Buffer.from("not a transaction").toString("base64"),
  },
  {
    name: "wrong asset: challenge says PRSM, transaction moves HBAR",
    expectApproved: false,
    challenge: honestChallenge,
    tx: build((t) =>
      t.addHbarTransfer(acct(AGENT), Hbar.fromTinybars(-20000)).addHbarTransfer(acct(SERVICE), Hbar.fromTinybars(20000)),
    ),
  },
];

console.log("\nPOLICY CO-SIGNER — adversarial tests\n" + "=".repeat(72));
let pass = 0;
let fail = 0;
for (const c of cases) {
  const r = await requestCosign({ transactionBase64: c.tx, challenge: c.challenge });
  const ok = r.approved === c.expectApproved;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${c.name}`);
  console.log(`        → ${r.approved ? "SIGNED" : "refused"}: ${r.reason}`);
  if (!ok && r.approved) console.log("        *** the co-signer added its key to a malicious transaction ***");
}
console.log("=".repeat(72));
console.log(`  ${pass} passed, ${fail} failed\n`);
client.close();
process.exitCode = fail === 0 ? 0 : 1;
