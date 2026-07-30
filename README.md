# Prism

**A payment that arrives already divided.**

An agent pays for something. It signs one transfer, of one amount, to one account — and it signs nothing about who else gets paid. By the time that transfer reaches consensus, the money is sitting in three accounts.

No splitter contract. No `distribute()` call. No keeper waking up afterwards to move what a contract is holding. The division happens *inside* the transfer, performed by the network as part of executing it, and it shows up in the record as `assessed_custom_fees`.

Built for the [Hedera x402 bounty](https://hedera.com/x402-bounty/) on stock `@x402/hedera` v2.19.0 against **unmodified public facilitators**. A build that needs its own facilitator has proven something about itself, not about the standard.

---

## Part one — the primitive

### One field, not one contract

An HTS fungible token carries a list of `FractionalFee` entries, each naming a collector account. When the token moves, consensus nodes assess every fee and merge the resulting transfers into the same `CryptoTransfer`. From `custom_fees.proto`:

> *"The transfer of value SHALL be merged into the original transaction to minimize the number of actual transfers. This descriptor presents the fee assessed separately in the record stream so that the details of the fee assessed are not hidden in this process."*

Two consequences carry the whole design:

**The split is absent from the signed body.** The buyer's client never constructs it and cannot see it in the bytes it signs. A facilitator decompiling that payload sees one clean transfer to `payTo`.

**The split is fully present in the record.** Each share appears as an `AssessedCustomFee` with its amount, its collector, and the account that effectively bore it.

Paying four parties costs one transfer, not four. The split is free because it is not a separate action.

### What one payment looks like

```
agent  0.0.9795796   ThresholdKey 2-of-2, holding zero HBAR

402    20000 of 0.0.9795837 → 0.0.9795832
       feePayer 0.0.9185802 sponsors the network fee

       what the 402 discloses before anything is signed:
         service        75.00%   via payTo
         upstream-data  15.00%   via assessed_custom_fee
         referrer       10.00%   via assessed_custom_fee

       agent signs         1 of 2 signatures — not yet spendable
       policy co-signs     within cap, payee and asset allowlisted

200    paid and served
       what the network actually assessed:
         upstream-data   3000
         referrer        2000
```

The agent signed a body crediting the service the full 20000 and naming no collector at all. The ledger recorded service +15000, upstream +3000, referrer +2000.

### Check it yourself

Every claim here is a public read. Nothing needs our cooperation.

```bash
curl https://testnet.mirrornode.hedera.com/api/v1/tokens/0.0.9795837
curl https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.9185802-1785182206-410586804
```

| | Transaction |
|---|---|
| End-to-end x402 payment, split three ways | [`0.0.9185802-1785182206-410586804`](https://hashscan.io/testnet/transaction/0.0.9185802-1785182206-410586804) |
| Threshold-key payer via **x402.org** | [`0.0.9185802-1785181090-410250982`](https://hashscan.io/testnet/transaction/0.0.9185802-1785181090-410250982) |
| Threshold-key payer via **blocky402** | [`0.0.7162784-1785181097-148987684`](https://hashscan.io/testnet/transaction/0.0.7162784-1785181097-148987684) |
| HBAR control route, split deliberately off | [`0.0.9185802-1785181765-383694018`](https://hashscan.io/testnet/transaction/0.0.9185802-1785181765-383694018) |
| Refraction in isolation, no x402 | [`0.0.9795422-1785180696-292474281`](https://hashscan.io/testnet/transaction/0.0.9795422-1785180696-292474281) |

Live entities: token **PRSM `0.0.9795837`** · agent `0.0.9795796` · service `0.0.9795832` · upstream `0.0.9795833` · referrer `0.0.9795835`

### The balances have to agree

A linked transaction can be cherry-picked. A running balance cannot.

```
$ npm run reconcile

  service   0.0.9795832    75%      365000
  upstream  0.0.9795833    15%       69000
  referrer  0.0.9795835    10%       46000

  implied gross volume, derived independently:
    from upstream  460,000
    from referrer  460,000
    collectors agree: yes

  gap               20,000
  1 payment(s) reached the service without splitting
  23 payments did split
```

Work backwards from each collector: 69,000 at 15% implies 460,000 of gross volume; 46,000 at 10% implies the same number. Two independent derivations landing on one figure means the split held across every payment, not only the ones we chose to link.

The gap is the interesting part. It is one payment made *from the token treasury*, which is permanently exempt from its own custom fees — so it did not split, and nothing errored. The arithmetic surfaces that on its own, which is why the audit endpoint checks identity rather than trusting conservation of value.

---

## Part two — what it is for

A revenue split only matters when somebody upstream actually did work and is actually owed money. So the demo is a business with a real supply chain.

### A studio that buys its own materials

**Prism Studio** sells short generated videos. A buyer asks for one and pays once. Behind that single payment the studio's agent does the work of a small production house:

1. Writes a script and a shot list.
2. Buys each scene image — `gemini-3.1-flash-lite-image`, ~3.4¢ a frame, seeded so a re-run is free.
3. Buys narration — `gemini-3.1-flash-tts-preview`, returned as raw 24 kHz PCM.
4. Buys a music bed — `lyria-3-clip-preview`, returned as MP3.
5. Composes the result with **HyperFrames** and renders the finished video.

Every purchase in steps 2–4 is its own x402 settlement. The studio is a **buyer** on those, and a **seller** on the video it delivers — which is the shape the agent economy is actually going to have, and the reason the buy-side guardrails below exist.

### Where refraction earns its place

The interesting question is not *whether* to split but *what the split is for*. Two rails, doing different jobs:

**Direct x402 pays cost of goods.** Each asset purchase is metered, per call, at the moment it happens.

**Refraction pre-funds the supply pool.** The custom fee on the buyer's payment lands in the account the studio spends from. Selling a video capitalises the generation of the next one — atomically, in the same transaction, with nothing to reconcile and nobody to trust.

That last property is the one no splitter contract can offer, because a contract has to be *told* to release funds by something that runs later.

### The economics have to close

The split is a property of the token, so the shares are fixed before the first sale and changing them takes 2-of-3 signatures. That means the arithmetic is a design step, not a tuning step.

Measured cost of one six-scene video: **~$0.24**, dominated almost entirely by images. For a pool share `s` and a price `P`, the pool survives only if `s·P ≥ cost`. At 15% that forces a price above $1.67. Prism Studio prices at **$2.00** and splits **50% studio / 35% supply pool / 15% referrer**, which leaves the pool roughly 70¢ against 25¢ of real cost — headroom for a longer script or a better image model without re-minting the token.

Two honest notes on this. The music model gives no duration control and has been observed between 26s and 173s for the same request, so its cost varies about 2× — and x402 `exact` has no refund path, so that variance is quoted conservatively and absorbed. And the studio needs its **own** token: the accounts already collecting on PRSM carry `all_collectors_are_exempt`, so reusing one as a payer would silently skip the split.

### Status

The primitive is settled on-chain and reproducible today: `npm run verify` drives a real payment and re-derives every claim from public data. The studio's asset purchasing is live in `studio/suppliers.mjs`, verified against all three models. Composition, the studio's own token, and the seller-side routes are **not built yet** — this section describes a design, and says so rather than implying otherwise.

---

## Why this is not a contract

ERC-20 has no protocol hook for dividing a transfer. On an EVM chain there are two ways to the same outcome:

**A splitter contract as `payTo`.** Not atomic. Funds land in the contract and a separate later call releases them. x402aff's own README is explicit: *"Payouts aren't atomic... **releasing** it (`distribute`) is a separate permissionless call."* That is a keeper dependency plus a window where the referrer's money belongs to a contract rather than the referrer. It is also not even available on Hedera in that form — a plain `CryptoTransfer` to a contract account does not run its code.

**A fee-on-transfer token.** This genuinely is atomic, and pretending otherwise would be dishonest. But the fan-out is bytecode *you wrote*, in *your* token, which you audit, which is a permanent exploit surface, and which is famous for breaking integrations that assume `transfer(amount)` moves `amount`.

So the claim is narrow and survives scrutiny: **on EVM, an atomic split needs custom token bytecode you are responsible for. On Hedera it is token configuration.** For a standard whose premise is software paying software with no human present, "nothing to audit" is the difference between trusting a public config and trusting someone's Solidity.

`HEDERA.md` argues this rail by rail, including the rails Prism deliberately does *not* use and why.

---

## Where this sits in the spec

The sharpest question about Prism, so it goes here rather than in a footnote.

The `exact` scheme's verification rules say the amount credited to `payTo` must equal the quoted amount, and that no additional positive net transfers to other parties may exist.

**What is proven.** Those checks read the client-signed body. `ExactHederaScheme.validateTransferSemantics` decodes with `Transaction.fromBytes` and inspects `hbarTransfers` / `tokenTransfers`. Custom fees are not there. `settle()` re-runs the same body checks and submits; nothing in the facilitator ever inspects the resulting record. Both public facilitators verified and settled a fee-bearing payment, and the transactions above are the evidence.

**What is not proven.** That this is unambiguously what the authors intended. At settlement, `payTo`'s net credit is the quote minus the disclosed fee. A reader applying amount-exactness to the *ledger outcome* rather than to the *signed transfer list* would say Prism violates it. The alternative — `net_of_transfers: true` — debits the buyer more than it was quoted, which is worse.

The claim is therefore deliberately narrow: **accepted by every current implementation, with the tension stated openly.** We do not claim the spec is silent and we have not found a blessing. What we do claim is that nobody is deceived — which is what the next section is for.

The spec's own Fee Payer Safety note does contemplate the mechanism, permitting the fee payer to appear as a positive entry *"for example when collecting fees or custom fee distributions."*

---

## Nobody is deceived

The mechanism works *because* the split is invisible to the signed body. Good for compliance, bad for trust. So Prism ships a first-class x402 v2 extension that closes the gap without touching the transfer.

**In the 402.** Every payee and share is declared before anything is signed — read from the token's own fee schedule on the mirror node, not from server config, so what is advertised cannot drift from what the ledger will do. Cached for 15 seconds, so a fee-schedule change could be advertised staler than that window. Bounded drift, not zero. The buyer consents by paying.

**In `PAYMENT-RESPONSE`.** The fees the network actually assessed, a HashScan link, and an audit URL.

**In the audit.** `GET /v1/audit/:txId` recomputes a settlement against the fee schedule in force *at its consensus timestamp*, from public data, holding no key. It checks identity as well as arithmetic — the asset, that the service was the sole non-collector recipient, that a single sender paid, that the network actually assessed fees. Conservation of value alone is necessary and nowhere near sufficient: without those checks the endpoint would cheerfully "verify" any balanced transfer that never touched Prism.

Scope, stated so nobody mistakes it: this verifies token movements against a fee schedule. It does not attest to off-chain custody, to who controls the collector accounts, or to whether the served data was correct. Inside that scope a mismatch is provable rather than arguable.

---

## Guardrails on the buyer

An agent that buys its own materials spends money unattended. Prism's payer account is a Hedera `KeyList` with threshold 2: the agent holds one key, a co-signer service holds the other. A compromised or hallucinating agent cannot overspend because the key material it possesses is **insufficient** — not because its code declines to.

Every other agent-spending guardrail in this space is application-layer: a limit checked by the agent's own code, or a row in the operator's database. Those are policies a process could skip. This one is arithmetic on signatures, evaluated by consensus nodes.

**The separation is real, and that took a correction.** The co-signer runs as its own process and is the only thing that reads `.policy.key`; the agent process never loads that material and reaches the co-signer over HTTP with a bearer token. An earlier version imported the co-signer in-process with both keys in one file — which gave the account the right *shape* on-chain while protecting nothing. A threshold key whose halves live in one process is theatre.

**What the boundary is, precisely.** A separate process, a separate 0600 key file, bearer auth, loopback binding. That defeats a compromised *agent*, which is the threat this design targets. It does not defeat a compromised *host* — anything with root can read the file. Production would put the co-signer in another trust domain, and the code is arranged so swapping the signer is the only change. The on-chain guarantee is unaffected either way: the network will not move funds without two signatures, wherever the keys live.

The co-signer decides against the **bytes that will be submitted**, never the summary the caller supplies — because a compromised agent controls that summary. `npm run attack` is eleven adversarial cases pairing a plausible challenge with a malicious transaction. It found two live holes in our own code:

- The policy allowlisted `challenge.payTo` without checking who the transaction actually **credited**, so a benign challenge could carry a transfer to anyone.
- The policy validated HBAR and fungible maps but never looked at **NFT transfers or allowance flags**. A Hedera `TransferTransaction` carries all of them in one body, so a numerically flawless payment could walk an NFT out while every amount check passed.

The fix for the second is a whitelist, not another special case: anything outside "plain transfers of the one expected asset" is refused, including shapes that do not exist yet. A policy that enumerates known attacks is obsolete the moment the SDK grows a field.

---

## Run it

```bash
npm install
cp .env.example .env
npm run keygen        # operator keypair (ECDSA); fund the printed address at
                      # portal.hedera.com/faucet
npm run whoami        # resolve the 0.0.x that funding created

npm run gate1         # prove custom fees refract and render
npm run gate2         # threshold payer settles via both facilitators;
                      #   also writes .policy.key
npm run phase1        # mint PRSM with the split in its fee schedule

npm run up            # both services, detached
npm run agent         # pay for a resource, end to end
npm run agent -- --route risk    # the HBAR control route
npm run demo          # the whole story, paced for a recording
```

Each setup step checks its own prerequisites, so running them out of order tells you which one is missing instead of throwing from inside `fs`. Budget roughly **35 HBAR** for a run from scratch — two `TokenCreateTransaction` calls at ~14.5 HBAR each dominate it.

`npm run up` starts two processes because that is the design: the co-signer's key must be somewhere the agent cannot reach. Run them separately with `npm run policy` and `npm run server` if you prefer. The agent fails loudly when the co-signer is unreachable, which is correct — without a second signature there is no payment to make.

## Tests

```bash
npm run verify     # 24 checks, end to end, against the live network
npm run attack     # 11 adversarial cases against the co-signer
npm run reconcile  # every payment ever settled, summed from public balances
```

`npm run verify` mocks nothing. It drives a real payment through the running server to a public facilitator, then re-derives the on-chain claims from public mirror-node data. It cannot prove the off-chain properties — key custody, the independence of the payee accounts, the safety of the plugin. Those rest on reading the code.

## Layout

```
prism/                 the primitive
  extension.mjs        the `prism` x402 extension: disclosure and receipts
  audit.mjs            keyless recomputation from public data
  mirror.mjs           public mirror-node reads
  policy.mjs           the co-signer's decision logic; sole reader of .policy.key
  policy-server.mjs    the co-signer as its own process (port 4052)

studio/                the demo
  server.mjs           Hono + @x402/hono resource server (port 4051)
  agent.mjs            buyer: 402 → sign → co-sign → retry → settle
  suppliers.mjs        image, narration and music generation
  intel.mjs            the metered counterparty service

scripts/               gates, setup and tests, each independently runnable
packages/hak-x402-plugin/   x402 tools for the Hedera Agent Kit
HEDERA.md              rail-by-rail justification, including what is *not* used
```

## The Agent Kit plugin

`@hashgraph/hedera-agent-kit@4.0.0` ships ten core plugins and none speak x402 — the package contains no x402 code at all. A Kit-built agent can mint tokens and cannot pay for an HTTP resource.

`packages/hak-x402-plugin` closes that with three v4 `BaseTool` tools: `x402_inspect_challenge` reads a 402 without paying and surfaces any disclosed split; `x402_pay_resource` runs the full cycle under a `maxAmount` ceiling; `x402_audit_settlement` verifies from the mirror node with no key.

`x402_pay_resource` splits the work the way the Kit intends. `coreAction` reads the 402 and builds the transfer **frozen but unsigned**; `postCoreActionHook` then runs, which is where the Kit's spend limits and audit hooks get to inspect a concrete payment; only then does `secondaryAction` sign and submit. Doing the payment inside `coreAction` settles on-chain before any policy has seen it, which is how the first version worked. Proof through the real `execute()` path: [`0.0.9185802-1785182810-628054679`](https://hashscan.io/testnet/transaction/0.0.9185802-1785182810-628054679), audited clean.

## What Prism deliberately is not

- **Not a smart contract.** No Solidity, no deployment, no bytecode. There is still plenty to audit — JavaScript, a key-holding service, protocol behaviour — the claim is narrowly that the *split itself* is configuration rather than code. If a contract appears in the payment path, the central claim is abandoned.
- **Not a keeper or a batch job.** If anything must run *after* the payment to move money, it is not Prism.
- **Not a new scheme.** Stock `exact` against unmodified public facilitators.
- **Not a claim that x402 is broken.** The amount-exactness rule is a good rule; it stops a sponsoring fee payer being tricked into funding transfers it never agreed to. Prism satisfies it as written and discloses what happens underneath.

## Known limits

- **Fee-exempt payers silently do not refract.** The treasury and every collector are permanently exempt from that token's fees. If one of them pays, the service receives the full amount and no split happens — no error, no warning. We hit this for real, and the audit endpoint is what catches it.
- **The split is per-token, not per-call.** Fractional fees live on the token, so every transfer carries the same shares. Per-referrer economics means one token per referrer.
- **Ceilings.** Ten custom fees per token, but the binding limit is twenty balance adjustments per `CryptoTransfer`. Refract to a handful of payees, not a long tail.
- **A fee collector must sign `TokenCreate`.** Naming an account is not enough; without its signature the network returns `INVALID_SIGNATURE`. Not documented in the HIPs or the SDK docs.
- **The mirror node field is `effective_payer_account_ids`** — a plural array, not the singular name `custom_fees.proto` describes.
- **Shares are audited against the token's fee schedule at the transaction's consensus timestamp**, which the mirror node supports. Governance of that schedule is a 2-of-3 threshold key across the payees — real enforcement, but all three keys were generated by one operator on one machine, so the *independence* is structural rather than demonstrated. A testnet build cannot show otherwise.
- **Testnet only.**
