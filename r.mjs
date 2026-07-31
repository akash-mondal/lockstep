/* I am the requesting agent. Pay for a quote, with files attached. */
import { readFileSync } from "node:fs";
import "dotenv/config";
import { AccountId, Client, Hbar, PrivateKey, TransactionId, TransferTransaction } from "@hiero-ledger/sdk";
const STUDIO = "http://172.203.51.214:4071";
const id = process.env.BUYER_ID, key = PrivateKey.fromStringECDSA(process.env.BUYER_KEY.replace(/^0x/,""));
const client = Client.forTestnet().setOperator(AccountId.fromString(id), key);
const dec=(b)=>JSON.parse(Buffer.from(b,"base64").toString("utf8"));
const enc=(o)=>Buffer.from(JSON.stringify(o)).toString("base64");
const SP = process.env.SP;

const payload = {
  brief: "A ~30 second explainer for developers on Lockstep: a spending limit that is a " +
         "property of the agent's account rather than a promise from its own code. " +
         "Follow attached script.md for beat order and brand.md for the look. " +
         "Invent no claims beyond what the script states.",
  style: "precise machined mechanisms, near-black ground, one teal accent, no text in images",
  requester: id,
  attachments: [
    { name: "script.md", note: "the beats, in order", data: readFileSync(`${SP}/brief/script.md`).toString("base64") },
    { name: "brand.md",  note: "palette and type",    data: readFileSync(`${SP}/brief/brand.md`).toString("base64") },
  ],
};
const post = (path, h={}) => fetch(`${STUDIO}${path}`, {
  method:"POST", headers:{"content-type":"application/json",...h}, body: JSON.stringify(payload) });

try {
  const first = await post("/v1/quote");
  console.log("first response:", first.status);
  if (first.status !== 402) { console.log((await first.text()).slice(0,300)); process.exit(1); }
  const ch = dec(first.headers.get("payment-required")), a = ch.accepts[0];
  console.log(`402   ${a.amount} tinybar of ${a.asset} -> ${a.payTo}`);
  const amt = BigInt(a.amount);
  const tx = new TransferTransaction()
    .addHbarTransfer(AccountId.fromString(id), Hbar.fromTinybars(-amt))
    .addHbarTransfer(AccountId.fromString(a.payTo), Hbar.fromTinybars(amt))
    .setTransactionId(TransactionId.generate(AccountId.fromString(a.extra.feePayer)));
  tx.freezeWith(client);
  const signed = await tx.sign(key);
  console.log("paying for the quote...");
  const paid = await post("/v1/quote", { "payment-signature": enc({
    x402Version:2, resource: ch.resource, accepted: a,
    payload:{ transaction: Buffer.from(signed.toBytes()).toString("base64") } }) });
  console.log("quote:", paid.status);
  const out = await paid.json();
  console.log(JSON.stringify(out, null, 2).slice(0, 2600));
} finally { client.close(); }
