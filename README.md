<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./docs/logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="./docs/logo-light.svg">
  <img src="./docs/logo-dark.svg" alt="Lockstep" width="560">
</picture>

**Spending limits for [x402](https://x402.org) agents, enforced by the [Hedera](https://hedera.com) ledger.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![x402](https://img.shields.io/badge/x402-v2%20%C2%B7%20exact-6366f1)](https://docs.x402.org)
[![Hedera](https://img.shields.io/badge/Hedera-testnet%20%C2%B7%20HBAR-8259ef)](https://hashscan.io)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933)](https://nodejs.org)
[![No contracts](https://img.shields.io/badge/smart%20contracts-none-25b394)](#why-hedera)

</div>

An agent that buys its own materials spends money with nobody watching. Every guardrail in
this space is application-layer: a ceiling checked by the agent's own code, or a row in the
operator's database. Those are policies a process can skip, and a jailbroken or looping
agent skips them.

**Lockstep makes the limit a property of the account.** The agent's wallet is a Hedera
`KeyList` with threshold 2. The agent holds one key; a co-signer service holds the other. A
compromised agent cannot overspend because the key material it possesses is
**insufficient**, not because its code declines to. That is arithmetic on signatures,
evaluated by consensus nodes.

**It is built on Hedera specifically and would not work anywhere else.** On an EVM chain an
externally-owned account is one secp256k1 key; multi-party control means Gnosis Safe or
ERC-4337, which is a contract you deploy, audit and maintain. On Hedera it is a
[field on the account](https://docs.hedera.com/hedera/sdks-and-apis/sdks/keys/create-a-threshold-key),
validated by the network. Everything settles in **native HBAR**, the buyer pays **zero
network fees**, and anyone can recompute the whole bill from the free public mirror node.
There is **no smart contract in this system**.

**[Lockstep Studio](#lockstep-studio)** is the first service on it: an agent that is paid to
make a video, buys its own images, narration, music and transcription over x402, composes
and renders the result, and hands back a bill where every input is a settlement you can
check.

```js
// The agent proposes. The co-signer decides against the bytes that will be submitted.
const decision = await fetch(`${POLICY_URL}/cosign`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}` },
  body: JSON.stringify({ transactionBase64, challenge: accepted }),
}).then((r) => r.json());

if (!decision.approved) {
  // Not "disallowed". Impossible: the agent holds 1 of 2 required signatures.
  throw new Error(decision.reason);
}
```

---

## Table of contents

- [How Lockstep works](#how-lockstep-works)
- [Why Hedera](#why-hedera)
- [The co-signer](#the-co-signer)
- [Lockstep Studio](#lockstep-studio)
- [The receipt](#the-receipt)
- [Verification](#verification)
- [Quickstart](#quickstart)
- [API](#api)
- [Layout](#layout)
- [Hedera Agent Kit plugin](#hedera-agent-kit-plugin)
- [Built on](#built-on)
- [Status and known limits](#status-and-known-limits)
- [License](#license)

---

## How Lockstep works

### The gap

x402 makes an agent able to pay. It says nothing about stopping one. An agent that sells
work has to buy work, and the moment it spends unattended you need an answer to "what stops
it spending everything?"

Every available answer is a promise. A `maxAmount` in the agent's own tool call is checked
by the agent. A spend limit in the operator's dashboard is checked by the operator's code.
A budget in a system prompt is a suggestion. All of them assume the thing being limited is
cooperating, which is exactly the assumption that fails when an agent is compromised,
jailbroken, or simply stuck in a loop buying the same image forty times.

### What Lockstep does about it

The agent's account requires two signatures. It holds one.

```
agent wallet   KeyList, threshold 2
                 ├── agent key        held by the agent process
                 └── co-signer key    held by a separate service, 0600, loopback

payment        agent signs            1 of 2, not yet spendable
               co-signer signs        2 of 2, submitted
               co-signer refuses      no signature exists, so no payment exists
```

The refusal is not a rejection the agent can retry past. There is no second path. Consensus
nodes will not accept the transfer without both signatures, wherever those keys live.

### The shape on the wire

```
agent  0.0.9795796      ThresholdKey 2-of-2, holds only what it means to spend

  → POST /v1/image
  ← 402  PAYMENT-REQUIRED
         25000000 tinybar of 0.0.0  →  0.0.9766034
         extra.feePayer 0.0.9185802          the facilitator sponsors the network fee

  agent signs                                1 of 2 signatures
  → POST /cosign  {transactionBase64, challenge}
  ← 200  approved: within cap, payee and asset allowlisted     2 of 2

  → POST /v1/image   PAYMENT-SIGNATURE: <fully signed transfer>
  ← 200  paid and served
         transaction 0.0.9185802-1785429017-537367644
```

**The co-signer decides against the bytes, never the summary.** A compromised agent controls
the description it hands over, so the challenge is used only to look up the cap; the payee,
the amount and the asset are all re-derived from the transaction that will actually be
submitted.

---

## Why Hedera

### The limit is a field on the account, not a contract

This is the whole argument, and it is narrow enough to survive scrutiny.

An EVM externally-owned account is one key. To require two signatures you deploy a contract:
Gnosis Safe, or an ERC-4337 smart account. That contract is bytecode you are responsible
for, with an audit surface, a deployment cost and an upgrade story. Every agent wallet is a
deployment.

On Hedera, `KeyList.withThreshold(2)` passed to `AccountCreateTransaction` produces an
account that behaves like any other and requires two signatures. Nothing is deployed. There
is nothing to audit but the policy you wrote.

For a standard whose premise is software paying software with no human present, that is the
difference between a guarantee you can read off the ledger and one you take on trust from
somebody's Solidity.

### The reference signer already supports it

This rail is not a workaround; it is already in the standard's own Hedera implementation.
From `@x402/hedera@2.19.0`:

```js
function keySignsTransaction(key, tx) {
  if (key instanceof PublicKey) return key.verifyTransaction(tx);
  if (key instanceof KeyList) {
    const keys = key.toArray();
    const threshold = key.threshold && key.threshold > 0 ? key.threshold : keys.length;
    return keys.filter((k) => keySignsTransaction(k, tx)).length >= threshold;
  }
  return false;
}
```

Both public facilitators verify a threshold-key payer without special-casing. It works
today, and as far as we can tell nobody is exercising it.

### The buyer pays no network fees

Hedera's contribution to x402 is the fee-payer model: the client sets
`transactionId.accountId` to the facilitator's account and partially signs, then the
facilitator signs as fee payer and submits. Verified on every settlement here, the buyer's
balance moves by exactly the quoted amount and not one tinybar more.

That matters more for an agent than for a person. An agent can be provisioned with exactly
what it is allowed to spend, with no gas float to reason about and no top-up loop.

### Anyone can check it for free

The mirror node is public, unauthenticated and free:

```bash
curl https://testnet.mirrornode.hedera.com/api/v1/accounts/0.0.9795796
curl https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.9185802-1785429017-537367644
```

The first shows the payer's key type is `ProtobufEncoded`, meaning a KeyList rather than a
single key. The second shows what moved.

### Things learned the hard way

**An account with zero auto-association slots cannot receive an HTS token at all**, and the
transfer fails at consensus with `TOKEN_NOT_ASSOCIATED_TO_ACCOUNT` *after* `/verify` has
already passed. Create agent wallets with `setMaxAutomaticTokenAssociations(-1)`.

**A fee collector is structurally a terminal payee.** It cannot forward to a non-exempt
account: under `Inclusive` assessment the receiver bears the fee, so a collector sending
onward would have to collect on its own payment, and the network refuses the whole transfer
with `FAIL_INVALID`, a status that says nothing about the cause. Measured three ways in
[HEDERA.md](./HEDERA.md).

**A token minted without an admin key can never be renamed.** Its symbol is permanent from
the moment of creation.

---

## The co-signer

It runs as its own process and is the only thing that reads `.policy.key`. The agent process
never loads that material and reaches the co-signer over HTTP with a bearer token.

**The separation is real, and that took a correction.** An earlier version imported the
co-signer in-process with both keys in one file. That gave the account the right *shape*
on-chain while protecting nothing. A threshold key whose halves live in one process is
theatre.

**What the boundary is, precisely.** A separate process, a separate `0600` key file, bearer
auth, loopback binding. That defeats a compromised *agent*, which is the threat this design
targets. It does not defeat a compromised *host*: anything with root can read the file.
Production would put the co-signer in a KMS, an HSM or another machine, and the code is
arranged so swapping the signer is the only change. The on-chain guarantee is unaffected
either way.

### It refuses eleven ways

`npm run attack` pairs a plausible challenge with a malicious transaction, eleven times. It
found two live holes in our own policy:

- The policy allowlisted `challenge.payTo` without checking who the transaction actually
  **credited**, so a benign-looking challenge could carry a transfer to any account.
- The policy validated the HBAR and fungible maps but never looked at **NFT transfers or
  allowance flags**. A Hedera `TransferTransaction` carries all of them in one signed body,
  so a numerically flawless payment could walk an NFT out while every amount check passed.

The fix for the second is a whitelist rather than another special case: anything outside
"plain transfers of the one expected asset" is refused, **including shapes that do not exist
yet**. A policy that enumerates known attacks is obsolete the moment the SDK grows a field.

---

## Lockstep Studio

A guardrail only means something when there is real money to lose. Lockstep Studio is an
agent with a wallet and a job.

It sells short narrated videos. A requesting agent sends a brief, attaches files, argues
about the plan, and pays. Then the studio's agent does the work of a small production house
and buys every input over x402:

1. Reads the attached brief and brand notes, and writes a storyboard.
2. Buys each scene image, `gemini-3.1-flash-lite-image`, seeded so a re-run costs nothing.
3. Buys narration, `gemini-3.1-flash-tts-preview`.
4. Buys a music bed, `lyria-3-clip-preview`.
5. Buys word timings, `scribe_v1`, so captions land on the spoken word.
6. Composes with **HyperFrames**, passes `lint` and `check`, and renders.
7. Buys a vision pass to look at its own frames, and fixes what it finds.

**Every one of those is a separate x402 settlement in HBAR**, and every one is checked
against the job's remaining budget *before* it happens. The agent cannot loop, cannot retry
past the ceiling, and cannot spend one job's money on another. Not because it is told not
to, but because the code that moves money refuses and the key it holds is insufficient.

### Two phases, because a price must precede the work

`exact` needs a firm amount before anything runs, and the cost of a video is not knowable
until it has been planned. So planning is its own cheap purchase that returns a quote, and
rendering is priced from the plan it refers to, through the per-request price callback the
scheme already blesses.

The quote is the job's own measured cost times a multiplier. The difference is the making
charge, and the receipt reports it rather than leaving it to be worked out from two other
numbers.

| job | asset cost | quote | making charge |
|---|---|---|---|
| 3 scenes | 1.40 ℏ | 4.20 ℏ | 2.80 ℏ |
| 6 scenes | 2.15 ℏ | 6.45 ℏ | 4.30 ℏ |
| 12 scenes | 3.65 ℏ | 10.95 ℏ | 7.30 ℏ |

### One workspace per job

Each request gets its own directory, and the agent is launched with its `cwd` set to it. The
failure being designed out is a shared scratch directory: everything looks fine until one
agent globs `*.jpg` and picks up another's scene. Verified by running two agents
concurrently, each given a secret, and checking neither could name the other's.

### The pipeline measures its own output

A paid job once settled 6.3 ℏ, bought five images, narration, word timings and a music bed,
rendered, reviewed, and delivered ten seconds of pure black. Every check passed. `index.html`
was still the scaffold it was created from.

Nothing in the pipeline was able to notice, and the reasons are worth stating because they
generalise past this project. `lint` and `check` pass on an untouched scaffold, because a
scaffold is valid; they were never able to answer the question. The vision reviewer was
handed the title and scene list alongside the frames, and wrote a fluent description of
sixteen metallic keys on a light grey surface. There were no keys. Given a plan and some
frames, it described the plan.

So the question is now answered by measurement rather than judgment. `contentStats` reads
average luma and frame-to-frame difference off the render: a composition that was never
written is black and never changes, and both conditions must hold before anything is
rejected. The reviewer is asked only what is visible and told to say so when the answer is
nothing.

The threshold is 20, not 0, because video black is `Y=16` rather than `Y=0` under limited
range. Testing against zero is the obvious mistake, and the first version of this check made
it and passed the very video that prompted it.

---

## The receipt

This is what the requesting agent gets back, and it is the part worth stealing.

```
=== WHAT I PAID
  6.3 ℏ  ->  one transfer, one account
  https://hashscan.io/testnet/transaction/0.0.9185802-1785473444-875780689
  I paid no network fee; the facilitator sponsored it.

=== WHAT IT BOUGHT ON MY BEHALF
  scene 1 image              0.25 ℏ   0.0.9185802@1785473449.744062763
  scene 2 image              0.25 ℏ   0.0.9185802@1785473454.828925103
  scene 3 image              0.25 ℏ   0.0.9185802@1785473459.012943014
  scene 4 image              0.25 ℏ   0.0.9185802@1785473463.767673253
  scene 5 image              0.25 ℏ   0.0.9185802@1785473471.998166801
  narration                  0.05 ℏ   0.0.9185802@1785473476.116024516
  word timings               0.10 ℏ   0.0.9185802@1785473493.420360819
  music bed                  0.50 ℏ   0.0.9185802@1785473500.219121379
  reviewing the render       0.08 ℏ   0.0.9185802@1785475226.952861675
  9 purchases, 1.98 ℏ of inputs
  Making charge kept by the studio: 4.32 ℏ

=== THE VIDEO
  http://.../v1/download/<job>?token=<capability>
```

Those are real transactions from one job, "Lockstep: Two Keys, One Motion", delivered as a
32 second 1080p film with narration and a music bed. Reading the inbound payment back off
the mirror node shows the buyer debited 6.30000000 ℏ and nothing else, the studio credited
the same, and the 0.0029 ℏ network fee paid by `0.0.9185802`, the facilitator. No token legs
on any of the ten transactions.


Plenty of systems can show an agent paying for something. **A bill that decomposes into the
purchases that produced the work, every line checkable by someone who does not trust us, is
the thing nobody else has.** It costs nothing extra: each purchase was already a settlement,
so the receipt is just refusing to throw the trail away.

---

## Verification

```bash
npm run verify     # end to end, against the live network
npm run attack     # 11 adversarial cases against the co-signer
```

`npm run verify` mocks nothing. It buys a real asset from the foundry through a public
facilitator, then re-derives every claim from the public mirror node rather than from
anything the service reported: that the seller was credited the quoted amount, that the
buyer was debited that amount and no more, that the facilitator paid the network fee, and
that no token moved. It also checks the studio refuses to sell a render nobody planned.

It cannot prove the off-chain properties, meaning key custody and the safety of the plugin.
Those rest on reading the code.

---

## Quickstart

Requires Node ≥ 20 and a funded Hedera testnet account.

```bash
npm install
cp .env.example .env

npm run keygen        # operator keypair (ECDSA); fund the printed address at
                      #   portal.hedera.com/faucet
npm run whoami        # resolve the 0.0.x that funding auto-created

npm run gate2         # build the threshold-key payer and settle through both
                      #   public facilitators; also writes .policy.key
npm run provision     # create the account the resource server is paid at

npm run up            # co-signer and resource server, detached
npm run agent         # pay for a resource, end to end
```

`npm run up` starts **two** processes because that is the design: the co-signer's key must
be somewhere the agent cannot reach. The agent fails loudly when the co-signer is
unreachable, which is correct, since without a second signature there is no payment to make.

To run the studio as well you need the foundry and studio services and a model-provider key;
see `.env.example`.

---

## API

### The foundry, everything in HBAR

| Route | Price |
|---|---|
| `POST /v1/image` | 0.25 ℏ |
| `POST /v1/speech` | 0.05 ℏ |
| `POST /v1/music` | 0.50 ℏ |
| `POST /v1/transcribe` | 0.10 ℏ |
| `POST /v1/vision` | 0.08 ℏ |

### The studio

| Route | Price | Does |
|---|---|---|
| `POST /v1/quote` | 0.05 ℏ | reads the brief and any attachments, returns a plan and a firm price |
| `POST /v1/discuss` | 0.05 ℏ | revise direction, script, length or scene count; re-prices |
| `POST /v1/render` | quoted | buy it; returns a job id immediately |
| `GET /v1/job/:id` | free | progress |
| `GET /v1/receipt/:id` | free | the bill, every line on HashScan |
| `GET /v1/download/:id?token=` | free | the video |

### The co-signer

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
lockstep/              the primitive
  policy.mjs           the co-signer's decision logic; sole reader of .policy.key
  policy-server.mjs    the co-signer as its own process
  mirror.mjs           public mirror-node reads, with backoff

studio/                the demo: an agent with a wallet and a job
  studio.mjs           quote, discuss, render, job, receipt, download
  worker.mjs           buy, compose, gate, render, review, deliver
  purchase.mjs         spending, under a ceiling the agent cannot raise
  plan.mjs             the storyboard the agent writes
  harness.mjs          the agent, confined to one workspace
  sessions.mjs         one directory per job
  house-style.mjs      the standing direction handed to the agent
  receipt.mjs          the bill

foundry/               the supply side: five models, sold over x402
scripts/               gates, setup and tests, each independently runnable
packages/hak-x402-plugin/   x402 tools for the Hedera Agent Kit
HEDERA.md              rail-by-rail justification, including what is not used
```

---

## Hedera Agent Kit plugin

`@hashgraph/hedera-agent-kit@4.0.0` ships exactly ten `core-*` plugins and **none speak
x402**; grepping the package's own source finds zero references. So a Kit-built agent can
mint tokens and cannot pay for an HTTP resource.

`packages/hak-x402-plugin` closes that with three v4 `BaseTool` tools:
`x402_inspect_challenge` reads a 402 without paying, `x402_pay_resource` runs the full cycle
under a `maxAmount` ceiling, and `x402_audit_settlement` verifies from the mirror node with
no key.

`x402_pay_resource` splits the work the way the Kit intends: `coreAction` builds the transfer
**frozen but unsigned**, `postCoreActionHook` runs so the Kit's own spend limits can inspect
a concrete payment, and only then does `secondaryAction` sign and submit. Doing the payment
inside `coreAction` settles on-chain before any policy has seen it, which is how the first
version worked.

---

## Built on

| | |
|---|---|
| [x402](https://x402.org) v2, `exact` scheme | `@x402/core`, `@x402/hedera`, `@x402/hono`, `@x402/fetch` at 2.19.0 |
| [Hedera](https://hedera.com) testnet, native HBAR | `@hiero-ledger/sdk` |
| Facilitators | [x402.org](https://x402.org/facilitator) and [blocky402](https://api.testnet.blocky402.com), both **unmodified** |
| Video | [HyperFrames](https://hyperframes.heygen.com) |
| Server | [Hono](https://hono.dev) |

Lockstep runs against unmodified public facilitators on purpose. Running your own lets you
relax any check you like, which proves nothing about interoperability.

---

## Status and known limits

Testnet only. Everything settles in native HBAR.

**The boundary is process-level, not host-level.** A separate process with a `0600` key file
defeats a compromised agent. It does not defeat root on the same machine. Production wants
the co-signer in a different trust domain.

**A refusal costs the buyer nothing, but a failed render does.** Payment settles before the
work starts, and `exact` has no refund path, so an unrecoverable failure leaves the buyer
paid up. The honest fix is an unprompted refund transfer recorded in the receipt; it is not
built yet.

**The quote is a firm price on an estimate.** If a model returns something longer or larger
than observed, the studio absorbs it. That is what the making charge is for, and it is why
the multiplier is 3x rather than something tighter.

**Consensus-assessed revenue splitting is documented but not shipped.** HTS custom fees can
divide one payment among several payees inside the transfer, with no contract. It needs an
HTS token, because a fee schedule is a field on a token record and HBAR has none. Lockstep
settles in HBAR, so the split is not part of this system. The analysis, including the
`FAIL_INVALID` finding, is kept in [HEDERA.md](./HEDERA.md) because the behaviour is real
and undocumented elsewhere.

---

## License

[MIT](./LICENSE)
