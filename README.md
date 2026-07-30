<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./docs/logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="./docs/logo-light.svg">
  <img src="./docs/logo-dark.svg" alt="Prism" width="560">
</picture>

**Revenue splits for [x402](https://x402.org) payments, performed by [Hedera](https://hedera.com) at consensus.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![x402](https://img.shields.io/badge/x402-v2%20%C2%B7%20exact-6366f1)](https://docs.x402.org)
[![Hedera](https://img.shields.io/badge/Hedera-testnet-8259ef)](https://hashscan.io)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933)](https://nodejs.org)
[![No contracts](https://img.shields.io/badge/smart%20contracts-none-e9a63f)](#why-hedera)

</div>

x402 pays one account. A real service has a supply chain behind it — the data provider whose
feed answered the call, the referrer that sent the buyer, the model that generated the
asset — and paying them normally means a second transaction, a splitter contract, or a
keeper job that moves the money later.

**Prism divides the payment inside the transfer.** The buyer's agent signs one clean transfer
of exactly the quoted amount to exactly one account. Consensus nodes assess the split and
merge it into that same `CryptoTransfer`, so by the time the payment is final the money is
already sitting in every payee's account. No splitter contract, no `distribute()` call,
nothing to run afterwards, and one network fee rather than four.

**It is built on Hedera specifically, and it would not work anywhere else.** The split is a
list of [`FractionalFee`](https://hips.hedera.com/hip/hip-18) entries on the token record —
configuration, not code, with no bytecode to deploy or audit. Who may change it is a
[`ThresholdKey`](https://docs.hedera.com/hedera/sdks-and-apis/sdks/keys/create-a-threshold-key)
across the payees themselves, enforced by the network. Every share the network assessed is
published in the record as `assessed_custom_fees`, so anyone can recompute the whole split
from the free public mirror node. The buyer pays **zero network fees** and can hold nothing
but the payment asset.

**[Prism Studio](#prism-studio)** is the first service on it: an agent that buys images,
narration and music, composes a video, and sells it — refracting each sale back to the
suppliers that made it possible.

```js
// The split is a field on the token, set once, at mint.
await new TokenCreateTransaction()
  .setTokenName("Prism").setTokenSymbol("PRSM").setDecimals(6)
  .setCustomFees([
    new CustomFractionalFee()                     // 15% to the upstream data provider
      .setNumerator(15).setDenominator(100)
      .setFeeCollectorAccountId(upstream)
      .setAssessmentMethod(FeeAssessmentMethod.Inclusive),
    new CustomFractionalFee()                     // 10% to whoever referred the buyer
      .setNumerator(10).setDenominator(100)
      .setFeeCollectorAccountId(referrer)
      .setAssessmentMethod(FeeAssessmentMethod.Inclusive),
  ])
  // 2-of-3 across the payees: nobody rewrites the split alone, including us.
  .setFeeScheduleKey(new KeyList([svcKey, upKey, refKey], 2))
  .execute(client);

// Then serve x402 the ordinary way. Nothing here knows about the split.
app.use(paymentMiddleware({
  "GET /v1/token/:id/cost": {
    accepts: [{ scheme: "exact", network: "hedera:testnet",
                price: { asset: PRSM, amount: "20000" }, payTo: service }],
    extensions: { prism: {} },                    // declares the split in the 402
  },
}, server));
```

The buyer signs a body crediting `service` the full `20000` and naming no collector at all.
The ledger records service **+15000**, upstream **+3000**, referrer **+2000**.

---

## Table of contents

- [How Prism works](#how-prism-works)
- [Why Hedera](#why-hedera)
- [Disclosure](#disclosure)
- [Where this sits in the spec](#where-this-sits-in-the-spec)
- [Guards on the buyer](#guards-on-the-buyer)
- [Prism Studio](#prism-studio)
- [Verification](#verification)
- [Quickstart](#quickstart)
- [API](#api)
- [Layout](#layout)
- [Hedera Agent Kit plugin](#hedera-agent-kit-plugin)
- [Built on](#built-on)
- [Status and known limits](#status-and-known-limits)
- [License](#license)

---

## How Prism works

### The gap

The x402 `exact` scheme is deliberately strict about where money goes. Its verification rules
require that the amount credited to `payTo` equals the quoted amount exactly, and that **no
additional positive net transfers to any other party may exist**. That rule is there for a
good reason: it stops a resource server tricking a sponsoring fee payer into funding
transfers it never agreed to.

It also means application-layer splitting is prohibited. A seller cannot add a second
recipient to the payment. The options left are all worse:

**A splitter contract as `payTo`.** Funds land in a contract and a separate, later call
releases them. Not atomic, and the referrer's money belongs to a contract until somebody
triggers the release.

**A second transaction after settlement.** Now there is a keeper, a queue, a retry policy,
and a window where the seller holds money it owes.

**Charging the buyer more.** Debits more than the quote. Honest sellers will not, and
buyers should not accept it.

### What Prism does about it

Prism does not add a recipient to the payment. It changes the **asset**, so that dividing is
something the network does while executing the transfer.

An HTS fungible token carries a `custom_fees` list. Each `FractionalFee` names a fraction and
a collector account. When the token moves, consensus nodes assess every fee and merge the
resulting transfers into the original transaction. From
[`custom_fees.proto`](https://github.com/hiero-ledger/hiero-consensus-node/blob/main/hapi/hedera-protobuf-java-api/src/main/proto/services/custom_fees.proto):

> *"The transfer of value SHALL be merged into the original transaction to minimize the number
> of actual transfers. This descriptor presents the fee assessed separately in the record
> stream so that the details of the fee assessed are not hidden in this process."*

Two consequences, and the whole design rests on them:

**The split is absent from the signed body.** The client never constructs it and cannot see it
in the bytes it signs. A facilitator decoding that payload sees one clean transfer to `payTo`
and every check passes as written.

**The split is fully present in the record.** Each share appears as an `AssessedCustomFee`
carrying its amount, its collector, and the account that effectively bore it. Nothing is
hidden after the fact; it is simply not in the part the buyer signs.

Because the fees are merged rather than appended, paying four parties costs the same network
fee as paying one. **The split is free because it is not a separate action.**

### The shape on the wire

```
agent  0.0.9795796      ThresholdKey 2-of-2, holds zero HBAR

  → GET /v1/token/0.0.429274/cost
  ← 402  PAYMENT-REQUIRED
         20000 of 0.0.9795837 → 0.0.9795832
         extra.feePayer 0.0.9185802          the facilitator sponsors the network fee
         extensions.prism.info               the split, declared before anything is signed
           service        7500 bps   via payTo
           upstream-data  1500 bps   via assessed_custom_fee
           referrer       1000 bps   via assessed_custom_fee

  agent signs                               1 of 2 signatures, not yet spendable
  policy co-signs                           within cap, payee and asset allowlisted

  → GET /v1/token/0.0.429274/cost   PAYMENT-SIGNATURE: <partially signed transfer>
  ← 200  PAYMENT-RESPONSE
         transaction 0.0.9185802-1785182206-410586804
         extensions.prism.refracted         what the network actually assessed
           upstream-data  3000
           referrer       2000
         audit /v1/audit/0.0.9185802-1785182206-410586804
```

**The split is derived from the token's own fee schedule, never from server config.** The 402
is built by reading `custom_fees` off the mirror node, so what Prism advertises cannot drift
from what the ledger will do. It is cached for 15 seconds, which bounds the drift rather than
eliminating it.

---

## Why Hedera

### The split is configuration, not code

ERC-20 has no protocol hook for dividing a transfer. On an EVM chain there are exactly two
routes to the same outcome, and both mean owning code.

A **splitter contract** is not atomic — [x402aff](https://github.com/MiroShark/x402aff)'s own
README says so plainly: *"Payouts aren't atomic... **releasing** it (`distribute`) is a
separate permissionless call."* A **fee-on-transfer token** genuinely is atomic, and
pretending otherwise would be dishonest — but that fan-out is bytecode you wrote, in your
token, which you audit, which is a permanent exploit surface, and which is notorious for
breaking integrations that assume `transfer(amount)` moves `amount`.

So the claim is narrow and survives scrutiny: **on EVM an atomic split needs custom token
bytecode you are responsible for; on Hedera it is a field on the token.** For a standard
whose premise is software paying software with no human present, "nothing to audit" is the
difference between trusting a public config and trusting somebody's Solidity.

There is a second, sharper point: the splitter-contract pattern is not even *available* here
in the form Base uses, because a plain Hedera `CryptoTransfer` to a contract account does not
execute that contract's code.

### The payees govern the split, not the seller

The `fee_schedule_key` authorises exactly one thing — replacing the token's custom-fee list —
and nothing else. Prism sets it to a 2-of-3 `KeyList` across the three payees, so the network
will not accept a `TokenFeeScheduleUpdate` without two of them signing.

Compare the EVM equivalent: an `onlyOwner` setter behind a proxy, where "it only changes the
split" is a claim about source code rather than a property of the ledger, and the proxy admin
could change anything.

**Stated honestly:** all three payee keys in this demo were generated by one operator and sit
on one machine. The enforcement is real and would bind genuinely independent parties. The
*independence* is not something a testnet build can demonstrate, and this README will not
pretend it does.

### The buyer needs no HBAR

Hedera's contribution to x402 is the fee-payer model: the client sets `transactionId.accountId`
to the facilitator's account and partially signs; the facilitator signs as fee payer and
submits. The buyer holds the payment asset and nothing else. Collectors hold nothing at all —
they only ever receive.

### Anyone can check it for free

The mirror node is public, unauthenticated, and free. Two GETs recompute everything:

```bash
curl https://testnet.mirrornode.hedera.com/api/v1/tokens/0.0.9795837
curl https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.9185802-1785182206-410586804
```

**And no smart contract anywhere.** The mechanism is a token field, the governance is an
account key, and the proof is the record stream. Nothing is deployed.

### Things learned the hard way

Two of these cost a failed run and neither appears in the HIPs or the SDK docs.

**A fee collector must sign `TokenCreateTransaction`.** Naming an account in
`feeCollectorAccountId` is not enough — it has to consent, or the network returns
`INVALID_SIGNATURE`. This is separate from, and additional to, the
`TOKEN_NOT_ASSOCIATED_TO_FEE_COLLECTOR` association rule.

**The mirror node returns `effective_payer_account_ids`** — plural, an array — where the
protobuf documents a singular `effective_payer_account_id`. Reading the documented name
yields `undefined` on an otherwise correct record.

**A misordered min/max silently flattens a percentage into a flat fee.** The protobuf warns
that if `maximum_amount <= minimum_amount` then `fractional_amount` has no effect at all.
Prism sets neither, so the fraction always governs.

**Testnet USDC can never carry a split.** `0.0.429274` reports `"fee_schedule_key": null`, and
a token created without that key can never acquire one. Not Circle declining — the ledger
refusing. This is why Prism mints its own asset, and the `exact` scheme accepts any HTS
fungible token by id, which is what makes that legal rather than a workaround.

---

## Disclosure

The mechanism works *because* the split is invisible to the signed body. That is good for
compliance and bad for trust, so Prism ships a first-class x402 v2 extension that closes the
gap without touching the transfer.

**In the 402, before anything is signed.** `enrichPaymentRequiredResponse` declares every
payee and share, read live from the token's fee schedule. The buyer consents by paying.

**In `PAYMENT-RESPONSE`, after settlement.** `enrichSettlementResponse` returns the fees the
network actually assessed, a HashScan link, and an audit URL.

**In a keyless audit anyone can run.** `GET /v1/audit/:txId` recomputes a settlement against
the fee schedule in force *at that transaction's consensus timestamp*, from public data,
holding no key and needing no cooperation from us.

The audit checks identity as well as arithmetic — the asset, that the service account was the
sole non-collector recipient, that a single sender paid, and that the network actually
assessed fees. **Conservation of value alone is necessary and nowhere near sufficient:**
without those checks the endpoint would cheerfully "verify" any balanced transfer that never
touched Prism.

Its scope, stated so nobody mistakes it: this verifies token movements against a fee schedule.
It does not attest to off-chain custody, to who controls the collector accounts, or to whether
the served data was correct. Inside that scope a mismatch is provable rather than arguable.

---

## Where this sits in the spec

This is the sharpest question about Prism, so it goes in the README rather than a footnote.

**What is proven.** The `exact` scheme's checks read the client-signed body.
`ExactHederaScheme.validateTransferSemantics` decodes with `Transaction.fromBytes` and inspects
`hbarTransfers` / `tokenTransfers`. Custom fees are not there. `settle()` re-runs the same body
checks and submits; nothing in the facilitator ever inspects the resulting record. Both public
facilitators verified and settled a fee-bearing payment — [via
x402.org](https://hashscan.io/testnet/transaction/0.0.9185802-1785181090-410250982) and [via
blocky402](https://hashscan.io/testnet/transaction/0.0.7162784-1785181097-148987684), tested
separately, neither inferred from the other.

**What is not proven.** That this is unambiguously what the authors intended. At settlement
`payTo`'s net credit is the quote minus the disclosed fee. A reader applying amount-exactness
to the *ledger outcome* rather than to the *signed transfer list* would say Prism violates it.
The alternative — `net_of_transfers: true` — debits the buyer more than it was quoted, which
we consider worse.

So the claim is deliberately narrow: **accepted by every current implementation, with the
tension stated openly.** We do not claim the spec is silent, and we have not found a blessing.

The spec's own Fee Payer Safety note does contemplate the mechanism, permitting the fee payer
to appear as a positive entry *"for example when collecting fees or custom fee distributions"* —
though that clause is about the fee payer, not about `payTo`'s net credit, and should not be
read as licensing this construction.

---

## Guards on the buyer

An agent that buys its own materials spends money unattended. Prism's payer account is a
Hedera `KeyList` with threshold 2: the agent holds one key, a co-signer service holds the
other. **A compromised or hallucinating agent cannot overspend, because the key material it
possesses is insufficient** — not because its code declines to.

Every other agent-spending guardrail in this space is application-layer: a limit checked by
the agent's own code, or a row in the operator's database. Those are policies a process could
skip. This one is arithmetic on signatures, evaluated by consensus nodes. On an EVM chain an
externally-owned account is one key; multi-party control means Safe or ERC-4337 — a contract.
On Hedera it is a field on the account.

**The separation is real, and that took a correction.** The co-signer runs as its own process
and is the only thing that reads `.policy.key`. The agent process never loads that material
and reaches the co-signer over HTTP with a bearer token. An earlier version imported the
co-signer in-process with both keys in one file, which gave the account the right *shape*
on-chain while protecting nothing. A threshold key whose halves live in one process is theatre.

**What the boundary is, precisely.** A separate process, a separate `0600` key file, bearer
auth, loopback binding. That defeats a compromised *agent*, which is the threat this design
targets. It does not defeat a compromised *host* — anything with root can read the file.
Production would put the co-signer in a KMS, an HSM, or another host, and the code is arranged
so swapping the signer is the only change required. The on-chain guarantee is unaffected
either way.

### The co-signer decides against the bytes, not the summary

The whole reason it exists is a compromised agent — and a compromised agent controls the
summary it hands over. So the challenge is used only to look up the cap; the payee, amount and
asset are all re-derived from the transaction that will actually be submitted.

`npm run attack` is eleven adversarial cases, each pairing a plausible challenge with a
malicious transaction. It found two live holes in our own code:

- The policy allowlisted `challenge.payTo` without checking who the transaction actually
  **credited**, so a benign-looking challenge could carry a transfer to any account.
- The policy validated the HBAR and fungible maps but never looked at **NFT transfers or
  allowance flags**. A Hedera `TransferTransaction` carries all of them in one signed body, so
  a numerically flawless payment could walk an NFT out of the agent's account while every
  amount check passed.

The fix for the second is a whitelist rather than another special case: anything outside
"plain transfers of the one expected asset" is refused, **including shapes that do not exist
yet**. A policy that enumerates known attacks is obsolete the moment the SDK grows a field.

---

## Prism Studio

A revenue split only means something when somebody upstream actually did work and is actually
owed money. Prism Studio is that supply chain, made real.

It sells short generated videos. A buyer asks for one and pays once. Behind that single
payment the studio's agent works like a small production house:

1. Writes a script and a shot list.
2. Buys each scene image — `gemini-3.1-flash-lite-image`, **~3.4¢ a frame**, seeded so a
   re-run costs nothing.
3. Buys narration — `gemini-3.1-flash-tts-preview`, returned as raw 24 kHz PCM.
4. Buys a music bed — `lyria-3-clip-preview`, returned as MP3.
5. Composes and renders the finished video with **HyperFrames**.

Every purchase in steps 2–4 is its own x402 settlement. **The studio is a buyer on those and
a seller on the video it delivers** — which is the shape the agent economy is actually going
to have, and the reason the buy-side guards exist at all.

### What the split is for

Two rails, doing different jobs. Confusing them means paying suppliers twice.

**Direct x402 pays cost of goods.** Each asset purchase is metered, per call, when it happens.

**Refraction pre-funds the supply pool.** The custom fee on a sale lands in the account the
studio spends from, so selling a video capitalises the generation of the next one —
atomically, in the same transaction, with nothing to reconcile and nobody to trust. **No
splitter contract can do this**, because a contract has to be told to release funds by
something that runs later.

### The arithmetic has to close before you mint

The split is a property of the token, so the shares are fixed before the first sale and
changing them takes 2-of-3 signatures. That makes this a design step, not a tuning knob.

Measured cost of one six-scene video is **~$0.24**, almost entirely images. For a pool share
`s` and a price `P`, the pool only survives if `s·P ≥ cost`. At 15% that forces a price above
$1.67. Prism Studio prices at **$2.00** and splits **50% studio / 35% supply pool / 15%
referrer**, leaving the pool roughly 70¢ against 25¢ of real cost — headroom for a longer
script or a better image model without re-minting.

Two honest notes. The music model exposes no duration control and has been observed producing
between 26 s and 173 s for the same request, so its cost varies about 2× — and `exact` has no
refund path, so that variance is quoted conservatively and absorbed. And the studio needs its
**own** token: the accounts already collecting on PRSM carry `all_collectors_are_exempt`, so
reusing one as a payer would silently skip the split.

### Status

**Built and verified:** the primitive, and the studio's asset purchasing
(`studio/suppliers.mjs`, working against all three models).
**Not built yet:** composition, the studio's own token, and the seller-side routes. This
section describes a design, and says so rather than implying otherwise.

---

## Verification

```bash
npm run verify     # 24 checks, end to end, against the live network
npm run attack     # 11 adversarial cases against the co-signer
npm run reconcile  # every payment ever settled, summed from public balances
```

`npm run verify` mocks nothing. It drives a real payment through the running server to a
public facilitator, then re-derives every on-chain claim from public mirror-node data — the
token's fee schedule, the threshold key on the payer, the disclosure in the 402, the assessed
fees, and the conservation of value. It cannot prove the off-chain properties: key custody,
the independence of the payee accounts, or the safety of the plugin. Those rest on reading the
code.

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

Work backwards from each collector: 69,000 at 15% implies 460,000 of gross volume; 46,000 at
10% implies the same number. **Two independent derivations landing on one figure** means the
split held across every payment, not only the ones we chose to link.

The gap is the useful part. It is one payment made *from the token treasury*, which is
permanently exempt from its own custom fees — so it did not split, and nothing errored. The
arithmetic surfaces that on its own, which is exactly why the audit endpoint checks identity
instead of trusting conservation of value.

---

## Quickstart

Requires Node ≥ 20 and a funded Hedera testnet account. Budget roughly **35 HBAR** for a run
from scratch — two `TokenCreateTransaction` calls at ~14.5 HBAR each dominate it.

```bash
npm install
cp .env.example .env

npm run keygen        # operator keypair (ECDSA); fund the printed address at
                      #   portal.hedera.com/faucet
npm run whoami        # resolve the 0.0.x that funding auto-created

npm run gate1         # prove custom fees refract and render
npm run gate2         # threshold payer settles via both public facilitators;
                      #   also writes .policy.key, the co-signer's half
npm run phase1        # mint PRSM with the split in its fee schedule

npm run up            # both services, detached
npm run agent         # pay for a resource, end to end
npm run agent -- --route risk    # the HBAR control route, split off
npm run demo          # the whole story, paced for a recording
```

Each setup step checks its own prerequisites, so running them out of order tells you which one
is missing rather than throwing from inside `fs`.

`npm run up` starts **two** processes because that is the design: the co-signer's key must be
somewhere the agent cannot reach. Run them individually with `npm run policy` and
`npm run server` if you prefer. The agent fails loudly when the co-signer is unreachable,
which is correct — without a second signature there is no payment to make.

---

## API

The resource server listens on **4051**, the co-signer on **4052**.

### Paid

| Route | Price | Asset | Split |
|---|---|---|---|
| `GET /v1/token/:id/cost` | $0.02 | PRSM | **on** |
| `GET /v1/account/:id/risk` | ~$0.002 | HBAR (`0.0.0`) | **off** — control |

Both run through the same server, the same middleware and the same facilitator. The only
difference is the asset, which is the cleanest available demonstration of what a fee schedule
adds. `/v1/token/:id/cost` answers *"what will this HTS token actually cost me to send?"* — an
x402 quote names an amount, but on Hedera the asset itself can carry custom fees, so the
recipient may land less than the quote. **It is also the tool that discloses Prism's own split
to a stranger.**

### Free

| Route | Returns |
|---|---|
| `GET /v1/audit/:txId` | keyless recomputation of a settlement from public data |
| `GET /v1/split` | the live fee schedule, read from the token |
| `GET /health` | liveness, asset, facilitator |
| `GET /.well-known/x402` | discovery document |
| `GET /openapi.json` | OpenAPI 3.1 with `x-payment-info` |

Audit is deliberately free and keyless. Charging for the ability to check us would defeat the
point.

### Co-signer

| Route | Returns |
|---|---|
| `POST /cosign` | the second signature, or a refusal and no signature at all |
| `GET /policy` | the caps, allowlists and rate limit, published |
| `GET /decisions` | the last 50 decisions, refusals included |

A policy you cannot read is not a guarantee, and a guardrail nobody can review is hard to
trust.

---

## Layout

```
prism/                 the primitive
  extension.mjs        the `prism` x402 extension: disclosure and receipts
  audit.mjs            keyless recomputation from public data
  mirror.mjs           public mirror-node reads, with backoff
  policy.mjs           the co-signer's decision logic; sole reader of .policy.key
  policy-server.mjs    the co-signer as its own process (4052)

studio/                the demo
  server.mjs           Hono + @x402/hono resource server (4051)
  agent.mjs            buyer: 402 → sign → co-sign → retry → settle
  suppliers.mjs        image, narration and music generation
  intel.mjs            the metered counterparty service

scripts/               gates, setup and tests, each independently runnable
packages/hak-x402-plugin/   x402 tools for the Hedera Agent Kit
HEDERA.md              rail-by-rail justification, including what is deliberately not used
```

---

## Hedera Agent Kit plugin

`@hashgraph/hedera-agent-kit@4.0.0` ships ten core plugins and **none of them speak x402** —
the package contains no x402 code at all. So a Kit-built agent can mint tokens and cannot pay
for an HTTP resource.

`packages/hak-x402-plugin` closes that with three v4 `BaseTool` tools:

| Tool | Does |
|---|---|
| `x402_inspect_challenge` | read a 402 without paying; surfaces any disclosed split |
| `x402_pay_resource` | the full cycle, under a `maxAmount` ceiling |
| `x402_audit_settlement` | keyless verification from the mirror node |

`x402_pay_resource` splits the work across the lifecycle the way the Kit intends. `coreAction`
reads the 402 and builds the transfer **frozen but unsigned**; `postCoreActionHook` then runs,
which is where the Kit's spend limits, allowlists and audit hooks get to inspect a concrete
payment; and only then does `secondaryAction` sign and submit. Doing the payment inside
`coreAction` settles on-chain before any policy has seen it, which is how the first version
worked. Proof through the real `execute()` path:
[`0.0.9185802-1785182810-628054679`](https://hashscan.io/testnet/transaction/0.0.9185802-1785182810-628054679),
audited clean.

---

## Built on

| | |
|---|---|
| [x402](https://x402.org) v2, `exact` scheme | `@x402/core`, `@x402/hedera`, `@x402/hono`, `@x402/fetch` at 2.19.0 |
| [Hedera](https://hedera.com) testnet | `@hiero-ledger/sdk` 2.85.0 |
| Facilitators | [x402.org](https://x402.org/facilitator) and [blocky402](https://api.testnet.blocky402.com), both **unmodified** |
| HIPs | [18](https://hips.hedera.com/hip/hip-18) and [573](https://hips.hedera.com/hip/hip-573) custom fees |
| Server | [Hono](https://hono.dev) |

Prism runs against unmodified public facilitators on purpose. Running your own lets you relax
any check you like, which proves nothing about interoperability.

---

## Status and known limits

Testnet only. The primitive is settled on-chain and reproducible; Prism Studio is partly built,
as marked above.

**Fee-exempt payers silently do not refract.** The token treasury and every fee collector are
permanently exempt from that token's custom fees. If one of them pays, the service receives the
full amount and no split occurs — no error, no warning. We hit this for real, and the audit
endpoint is what catches it.

**The split is per-token, not per-call.** Fractional fees live on the token, so every transfer
of it carries the same shares. Per-referrer economics means one token per referrer.

**Ceilings.** Ten custom fees per token, but the binding limit is **twenty balance adjustments
per `CryptoTransfer`**. Count adjustments, not fees. Refract to a handful of payees, not a long
tail.

**A fee-schedule update races in-flight payments.** A buyer's signed body stays valid, so
nothing fails — but a payment settling after an update is assessed under the new schedule, not
the one its 402 advertised. This is why the audit compares against the schedule at the
transaction's consensus timestamp.

**Shares are audited against the schedule at consensus time**, which the mirror node supports
via `?timestamp=`. Governance of that schedule is a 2-of-3 threshold key across the payees —
real enforcement, but all three keys were generated by one operator on one machine, so the
independence is structural rather than demonstrated.

**The denomination is nominal.** PRSM is a token we mint, so "$0.02" is a chosen unit
convention, not an exchange rate.

---

## License

[MIT](./LICENSE)
