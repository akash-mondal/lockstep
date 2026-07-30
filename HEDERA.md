# Hedera capabilities used by Prism

Prism's claim is that a single x402 payment can pay several parties atomically, without a contract, without a keeper, and without the buyer knowing. This file justifies that claim rail by rail: what each capability is, the exact API surface, the parameters that decide behaviour, the gotchas, and — for each one — an honest answer to *"could you just do this on an EVM chain?"*

Everything below was verified on **2026-07-27** against the sources named at the end. Anything not verified is labelled.

**Status:** the design questions this document opened are now closed by live testnet
evidence rather than by reading. See §11 for what each check returned, and the
README for the settled transactions. One caveat carried forward: this file argues
that Prism's construction is what the `exact` scheme permits, and that claim is
narrower than it first appears — the facilitator checks provably pass, but a reader
who applies Rule 5's amount-exactness to the *ledger outcome* rather than to the
signed transfer list would disagree. The README states that tension in full under
"The honest position on Rule 5"; it is not resolved here.

---

## The inventory

| Capability | HIP / spec | What it does | What it does **for Prism** |
|---|---|---|---|
| **HTS fractional custom fees** | HIP-18 (Final, v0.16.0) → HIP-573 (Final, v0.31.0) | Takes a fraction (≤ 1) of a fungible transfer and routes it to collector accounts inside the same `CryptoTransfer`, at consensus | **The entire mechanism.** This is what refracts one payment into many, atomically, with no code deployed |
| **`fee_schedule_key` + `TokenFeeScheduleUpdate`** | HIP-18 / HIP-573 | A dedicated key authorising revision of a token's custom-fee list after creation | Lets the split table change as the supply chain changes, with no redeploy and no proxy |
| **`KeyList` / `ThresholdKey` account keys** | Native (HAPI `Key`) | Native N-of-N or M-of-N control of an **account**, with no contract | Multi-party governance of the fee schedule key: the payees collectively control who gets paid what |
| **x402 fee-payer sponsorship** | `scheme_exact_hedera.md` (Hedera's contribution upstream) | Client partially signs; facilitator signs as `transactionId.accountId` and submits | Buyer and every collector can hold **zero** HBAR. A payer provably needs no gas |
| **`assessed_custom_fees` in the record stream** | HAPI `AssessedCustomFee` | Reports each fee separately from the merged transfer list | The proof surface. Judges and counterparties verify the split from public data |
| **Mirror node** (`testnet.mirrornode.hedera.com`) | — | Free, public, unauthenticated REST read-back | Independent recomputation of the split; also what the reference facilitator uses to resolve payer keys and check association |
| **Fixed sub-cent transfer fees** | Hedera fee schedule | HBAR transfer $0.0001, HTS transfer $0.001 — fixed, not auctioned | Solvency. A percentage of a fraction of a cent is meaningless if the transfer fee floats |
| **Deterministic finality** | aBFT consensus | No reorg window; a receipt is final | Settlement is awaited inside the request; there is nothing to reverse |
| **HIP-991 revenue-generating topics** | HIP-991 (**Final**, release 0.59.5) | A per-message submit fee on an HCS topic, HBAR or HTS FT, governed by a Fee Schedule Key | **Explained but not used as the split mechanism** — see §9 for exactly why it cannot be |
| **HIP-423 long-term scheduled transactions** | HIP-423 (Final, v0.57.0) | Multi-party deferred signing, up to 62 days | **Deliberately excluded.** The scheme forbids it — see §10 |
| **HIP-336 allowances / approvals** | HIP-336 (Final, v0.25.0) | Delegated spend authority | **Deliberately excluded** — see §10 |

---

## 1. HTS fractional custom fees — the mechanism

### What it is

An HTS fungible token carries a `custom_fees` list. Each entry is a `CustomFee` with a `fee_collector_account_id` and one of `FixedFee`, `FractionalFee`, or `RoyaltyFee`. Prism uses `FractionalFee`, which the protobuf describes as *"a fee based on a portion of the tokens transferred"* and which *"SHALL be assessed only for fungible/common tokens."*

When such a token moves, the network assesses each fractional fee and **merges the resulting transfers into the original transaction**. From `custom_fees.proto`, on `AssessedCustomFee`:

> *"It is important to note that this is not the actual transfer. The transfer of value SHALL be merged into the original transaction to minimize the number of actual transfers. This descriptor presents the fee assessed separately in the record stream so that the details of the fee assessed are not hidden in this process."*

Two consequences, and they are the two that Prism is built on:

1. **The fees are not in the signed transaction body.** The client never constructs them and cannot see them in what it signs. A facilitator decompiling the payload sees one clean transfer to `payTo`.
2. **The fees are fully disclosed in the record.** Each one appears as an `AssessedCustomFee` with `amount`, `token_id`, `fee_collector_account_id`, and `effective_payer_account_id`.

### The API surface

Token creation, via `TokenCreateTransaction`:

```
new CustomFractionalFee()
  .setNumerator(n)                      // n/d MUST be > 0 and <= 1
  .setDenominator(d)
  .setMin(minAmount)                    // optional; 0 = no minimum
  .setMax(maxAmount)                    // optional; 0 = no maximum
  .setFeeCollectorAccountId(accountId)
  .setAssessmentMethod(inclusiveOrExclusive)   // maps to net_of_transfers
  .setAllCollectorsAreExempt(bool)             // HIP-573
```

Read-back is `TokenInfoQuery`, or over REST `GET /api/v1/tokens/{id}` which returns a `custom_fees` object with `fixed_fees[]` and `fractional_fees[]`.

### The parameters that decide behaviour

**`net_of_transfers` is the one that matters most.** The protobuf spells out both branches:

> *"If this value is true — The receiver of a transfer SHALL receive the entire amount sent. The fee SHALL be charged to the sender as an additional amount, increasing the token transfer debit."*
> *"If this value is false — The receiver of a transfer SHALL receive the amount sent after deduction of the calculated fee."*

And `AssessedCustomFee.effective_payer_account_id` confirms who is really paying:

> *"This SHALL be the account that would have had a higher balance absent the fee. In most cases this SHALL be the `sender`, but some fractional fees reduce the amount transferred, and in those cases the `receiver` SHALL be the effective payer for the fee."*

For Prism this is the pricing decision, not an implementation detail. With `false` (the default), the quoted x402 `amount` is a **gross** price and the operator's take is what's left. With `true`, the quoted amount is the operator's **net** and the buyer is debited more than it was quoted. Both verify fine at the facilitator (§8); they are different products.

**`minimum_amount` / `maximum_amount`** are absolute unit amounts, not fractions. A subtle trap from the protobuf: *"This value SHOULD be strictly greater than `minimum_amount`. If this amount is less than or equal to `minimum_amount`, then the fee charged SHALL always be equal to this value and `fractional_amount` SHALL NOT have any effect."* A misordered min/max silently converts your percentage into a flat fee.

**`all_collectors_are_exempt`** (HIP-573). The treasury and a fee's own collector are *always* exempt. Setting this true additionally exempts every other collector on the token from this fee. Relevant because Prism's collectors will themselves hold and sometimes send the token.

### The gotchas

- **Collectors must be associated before token creation.** `TOKEN_NOT_ASSOCIATED_TO_FEE_COLLECTOR` (235): *"Any of the token Ids in customFees are not associated to feeCollector."* Inconvenient, and also a gift — the network makes it impossible to ship a fake split pointing at accounts that never existed.
- **Multi-recipient inclusive fees are approximate.** *"When a single transaction sends tokens from one sender to multiple recipients, and the `net_of_transfers` flag is false, the network SHALL attempt to evenly assess the total fee across all recipients proportionally. This may be inexact..."* Not a problem for Prism (one `payTo`, mandated by Rule 5), but it forecloses future designs.
- **Fees can starve a transfer.** *"If the sender lacks sufficient tokens to pay fees, or the assessment of custom fees reduces the net amount transferred to or below zero, the transaction MAY fail due to insufficient funds to pay all fees."* Failure code: `INSUFFICIENT_SENDER_ACCOUNT_BALANCE_FOR_CUSTOM_FEE` (259).
- **Hard limits.** 10 custom fees per token (`CUSTOM_FEES_LIST_TOO_LONG`, 232). Two levels of fee-chain depth (`CUSTOM_FEE_CHARGING_EXCEEDED_MAX_RECURSION_DEPTH`, 257). And the real ceiling: `CUSTOM_FEE_CHARGING_EXCEEDED_MAX_ACCOUNT_AMOUNTS` (258) — *"More than 20 balance adjustments were to satisfy a CryptoTransfer and its implied custom fee payments."* Count adjustments, not fees.
- **The split is a property of the token, not the call.** Every transfer of that token carries the same fees. Per-call variable splits require either separate tokens or a fee-schedule update between calls, which races in-flight payments.
- **USDC is out.** Hedera testnet USDC `0.0.429274` reports `"fee_schedule_key": null` (verified via mirror node). A token created with no fee schedule key can never be given one. This is not Circle declining; it is the ledger refusing.

### Could you do this on an EVM chain?

**Not without deploying and owning code — and this is the strongest rail in the design.**

ERC-20 has no protocol-level hook for splitting a transfer. There are exactly two ways to get the same outcome on an EVM chain:

- **`payTo` is a splitter contract** (0xSplits or equivalent). This is what x402aff does on Base, and it is not atomic. Funds land in the contract; a *separate*, later `distribute()` call releases them. x402aff's own README: *"Payouts aren't atomic... **releasing** it (`distribute`) is a separate permissionless call - you, a keeper, or the builder can trigger it."* That is a keeper dependency, plus a window in which the referrer's money is held by a contract rather than by the referrer.
- **A fee-on-transfer ERC-20.** This *is* atomic, and honesty requires saying so — a fee-on-transfer token can fan out inside `transfer()`. But that fan-out is code **you wrote**, in **your** token contract, which you must audit, which is a permanent exploit surface, and which is notorious for breaking downstream integrations that assume `transfer(amount)` moves `amount`. On Hedera the identical behaviour is a **field on the token**, executed by consensus nodes, with no bytecode anywhere and nothing to audit.

So the precise claim — the one that survives scrutiny — is not "EVM cannot split atomically." It is: **on EVM, atomic split requires custom token bytecode you authored and are responsible for; on Hedera it is token configuration.** For a payment standard whose entire premise is software paying software without a human, "no contract to audit" is the difference between a mechanism you can trust by reading a token's public config and one you can trust only by reading someone's Solidity.

There is a second, sharper difference specific to Hedera: the splitter-contract pattern is not even *available* here in the form Base uses, because a plain Hedera `CryptoTransfer` to a contract account does not execute that contract's code. Porting the EVM design to Hedera would be a step backwards.

---

## 2. `fee_schedule_key` and `TokenFeeScheduleUpdate`

**What it is.** A distinct key on the token, separate from admin/supply/wipe/freeze, that authorises exactly one thing: replacing the token's custom-fee list. Set at `TokenCreateTransaction` time. Revised with `TokenFeeScheduleUpdateTransaction`. If the token was created without one, it can never acquire one — which is precisely why testnet USDC is permanently ineligible.

**What it does for Prism.** Supply chains change. A new upstream is added, a referral deal expires, a share is renegotiated. A `TokenFeeScheduleUpdate` signed by the fee schedule key rewrites the split for all future transfers. Nothing is redeployed and no address changes. Be precise about in-flight payments, though: a buyer's *signed body* is unaffected and stays valid, so nothing is invalidated in the sense of failing — but a payment that settles after the update is assessed under the new schedule, not the one disclosed in its 402. The signature survives; the split it experiences can differ from the one advertised. This is why the audit endpoint compares against the schedule in force at the transaction's consensus timestamp rather than today's.

**Gotchas.** `INVALID_CUSTOM_FEE_SCHEDULE_KEY` (247) and `FEE_SCHEDULE_KEY_NOT_SET` (381) are the failure codes. Updates are not retroactive. And an update between a 402 challenge and its settlement changes the split that payment experiences — the buyer's signed body is unaffected, the assessed fees are not.

**Could you do this on an EVM chain?** Yes, but as your own upgrade machinery: an `onlyOwner` setter on a splitter, or a proxy pointing at swappable logic. Achievable, and honestly not exotic. The difference is authority and blast radius. Hedera gives you a key that can change *only the fee schedule* and nothing else, enforced by the network. A proxy admin key can change the contract's entire behaviour, and "it only updates the split" is a claim about your source code rather than a property of the ledger. **This rail is meaningfully better on Hedera, not uniquely possible.** Stating it any stronger would be overselling.

---

## 3. `KeyList` / `ThresholdKey` account keys

**What it is.** A Hedera account's key is not required to be a single public key. It can be a `KeyList` (all must sign) or a `ThresholdKey` (M of N must sign), nested, natively, with no contract and no deployment. The account behaves like any other account; the signature requirement is enforced by the network at transaction validation.

**What it does for Prism.** The fee schedule key is the power to decide who gets paid what. Held by one operator, "the split is enforced on-chain" is only half true — the operator can rewrite it unilaterally tomorrow. Put the fee schedule key under a `ThresholdKey` whose members are the payees themselves, and changing the split requires the agreement of the parties it affects — the network will not accept a `TokenFeeScheduleUpdate` without the threshold met. That mechanism converts Prism from "a seller who promises to share" into "a group that jointly controls a revenue split".

One honest qualification, matching the README: in this demo all three payee keys were generated by one operator and live on one machine, so the multilateral property is structural rather than adversarially demonstrated. The enforcement is real; the independence of the parties is what a testnet build cannot show.

**The API surface.** `new KeyList([...keys])`, `KeyList.withThreshold(m)`, passed to `AccountCreateTransaction.setKey(...)` or `AccountUpdateTransaction`. Over REST the account's `key` comes back as `{_type: "ProtobufEncoded", key: "<hex>"}` and must be decoded with `proto.Key.decode(...)`.

**Verified, and directly relevant:** the x402 Hedera reference signer already handles this. In `@x402/hedera@2.19.0`:

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

with `parseMirrorKey` reconstructing `ProtobufEncoded` keys via `Key._fromProtobufKey`. So a threshold-controlled account can be an x402 **payer** on Hedera today, out of the box. That is a rail the standard already supports and that nobody appears to be exercising.

**Gotchas.** The reference implementation explicitly returns `signature_unverifiable` if `Key._fromProtobufKey` is missing, warning to *"check the `@hiero-ledger/sdk` / `@hiero-ledger/proto` version pins."* Threshold-key handling is version-sensitive. Also: a threshold-signed transaction needs all required signatures collected before it is sent, which for a *payer* means coordination inside `maxTimeoutSeconds`. Prism uses threshold keys in **two** places, and the coordination cost differs. The fee schedule key (2-of-3 across the payees) governs an occasional administrative action. The *payer* account is also a threshold key (2-of-2: agent plus policy co-signer), so every call does need two signatures collected inside `maxTimeoutSeconds` — comfortable against a co-signer service answering in milliseconds, but it is a live dependency, not a free property.

**Could you do this on an EVM chain?** **No — not for an account.** An EVM externally-owned account is one secp256k1 key, full stop. Multi-party control means a Gnosis Safe or an ERC-4337 smart account: a contract, with deployment cost, an audit surface, and an upgrade story. On Hedera it is a field on the account, validated by consensus nodes. This is a genuine categorical difference, and the prior-cycle audit's finding that **0 of 6 previous Hedera bounty winners ever constructed one** (inherited, not re-verified here) suggests it is also unclaimed.

---

## 4. The x402 fee-payer model

**What it is.** Hedera's own contribution to the x402 standard. `PaymentRequirements.extra.feePayer` names an account; the client sets `transactionId.accountId` to it and signs; the facilitator adds its signature as fee payer and submits. From the spec: *"this account must also sign the transaction as the fee payer."*

**What it does for Prism.** The buyer's agent needs the payment asset and nothing else — no HBAR, no gas, no top-up loop. Neither do the fee collectors; they only ever receive. An agent can be provisioned with exactly one token balance and transact. That is the machine-to-machine story the bounty is asking for, made literal.

**The API surface and the gotcha.** Read `extra.feePayer` from the 402 challenge, per challenge. Do not hardcode it. `ExactHederaScheme.getExtra()` is:

```js
const randomIndex = Math.floor(Math.random() * addresses.length);
return { feePayer: addresses[randomIndex] };
```

A facilitator managing several accounts hands out different fee payers on different challenges. And the two public facilitators differ anyway — `0.0.9185802` (x402.org) vs `0.0.7162784` (blocky402), both verified live. A hardcoded fee payer fails with `invalid_exact_hedera_payload_fee_payer_mismatch`.

**Safety rules the facilitator enforces.** The fee payer must not appear as a negative entry in any HBAR transfer list, nor in the token transfer list for the asset. It *may* appear positive — the spec's own words, *"for example when collecting fees or custom fee distributions"*. That clause shows the authors had custom fees in mind somewhere in the flow. It is about the **fee payer**, not about `payTo`'s net credit, so it does not license Prism's construction and should not be read as doing so; see the README's "honest position on Rule 5".

**Could you do this on an EVM chain?** Yes. ERC-4337 paymasters and EIP-7702 delegation both sponsor gas, and x402's EVM schemes use permit-style signatures for the same reason. **This rail is simpler and contract-free on Hedera, not unique to it.** On Hedera it is a protocol field; on EVM it is an account-abstraction stack. Real, but a difference of ergonomics.

---

## 5. `assessed_custom_fees` — the proof surface

**What it is.** Every custom fee assessed appears in the transaction record as an `AssessedCustomFee`: `amount`, `token_id` (absent for HBAR), `fee_collector_account_id`, and `repeated effective_payer_account_id`. Exposed over REST at `GET /api/v1/transactions/{transactionId}`.

**What it does for Prism.** The transfer list in the record shows the merged, final movements. The `assessed_custom_fees` array shows, separately and unambiguously, that N units went to collector X because of a custom fee, paid effectively by Y. A judge can open HashScan, see one payment, and see the split — with the transaction record itself stating who bore the cost. No application-level accounting is asked to be believed.

**Gotchas.** These appear only in the record, never in the signed body — which is what makes the whole design work and also what makes it invisible to any pre-consensus inspection. A settlement failure means no record and no fees; there is no partial state.

**Could you do this on an EVM chain?** Approximately, via events — a splitter contract emits logs, and an indexer reads them. The difference is that a log is a claim your contract chose to emit, while `AssessedCustomFee` is the ledger's own account of value it moved, in a HAPI-defined structure, produced by the consensus nodes. **This is a difference in trust basis, not in whether the data is obtainable.**

---

## 6. Mirror node

**What it is.** `https://testnet.mirrornode.hedera.com` — free, public, unauthenticated REST over all network state and history. `/api/v1/accounts/{id}`, `/api/v1/accounts/{id}/tokens`, `/api/v1/tokens/{id}`, `/api/v1/transactions/{id}`.

**What it does for Prism.** Two jobs. First, anyone can recompute the split independently: fetch the token's `custom_fees`, fetch the transaction, verify the assessed amounts match. Second — and this is already happening whether you use it or not — the reference facilitator depends on it. `createHederaVerifyPayerSignature` resolves the payer's public key from `/api/v1/accounts/{payer}`. `createHederaPreflightTransfer` checks payer balance and whether `payTo` is associated (including walking `/tokens` pages to count consumed auto-association slots against `max_automatic_token_associations`).

**Gotchas.** Mirror nodes lag consensus slightly; a record may not be queryable the instant a receipt returns. The facilitator's dependency on it means a mirror node outage is a verification outage. Prism retries every mirror read with exponential backoff, but treats a 404 as an answer rather than a transient — retrying "does not exist" only wastes time. And preflight only inspects `payTo` — never the fee collectors — which is exactly the gap in §11.

**Could you do this on an EVM chain?** Yes, with an indexer — but usually a keyed, rate-limited, paid one (Etherscan, Alchemy, The Graph). **Operational convenience, not a unique capability.** Worth one honest sentence, not a paragraph.

---

## 7. Fixed sub-cent fees and deterministic finality

**Fixed fees.** The bounty states it plainly: *"On Hedera they settle in seconds at a fixed fee of $0.001 per transfer. That fixed, predictable cost is what makes per-use payments viable."* HBAR transfers are $0.0001, HTS transfers $0.001.

**What it does for Prism.** A many-way split is only meaningful if the split is large relative to the cost of moving it. If a transfer fee is auctioned and can spike, a per-call micropayment can cost more than it earns, and a 10% share of it becomes noise. Fixed pricing is what makes the *unit economics* of refraction hold at micropayment size. Note also that the split itself is free — the fees are assessed inside the same `CryptoTransfer`, so paying four parties costs the same network fee as paying one. On any splitter-contract design, each additional payee is more gas.

**Finality.** Hedera's aBFT consensus has no reorg window; a receipt is final. This is why the x402 middleware can afford to await settlement inside the request (§8) rather than returning optimistically and reconciling later.

**Could you do this on an EVM chain?** **This is an economic property, not a capability, and it should not be dressed up as one.** L2s are cheap; some are very cheap. The honest claims are narrow: Hedera's fee is *fixed and denominated in USD* rather than auctioned, so it cannot spike under congestion; and the split costs nothing extra because it happens inside the transfer. On finality, the honest claim is that Hedera's is deterministic at consensus while EVM L1 is probabilistic and L2s carry their own settlement assumptions. Both are real. Neither is the reason Prism can exist.

---

## 8. The x402 ↔ Hedera interaction, exactly

### Call sequence

1. Client `GET`s a gated route with no payment header.
2. Middleware returns **402** with a `PAYMENT-REQUIRED` header: base64 JSON containing `scheme: "exact"`, `network: "hedera:testnet"`, `amount` (smallest units), `asset` (`"0.0.0"` for HBAR, else a token id), `payTo`, `maxTimeoutSeconds`, `extra.feePayer`. The reference repos bless a per-request `price: (ctx) => ...` callback, so the amount can be computed per call.
3. Client builds a **bare `TransferTransaction`**, sets `transactionId.accountId = extra.feePayer`, debits itself, credits `payTo` exactly `amount`, signs with its own key. Result is **partially signed** — the fee payer's signature is missing.
4. Client re-sends the request with the base64 transaction in a `PAYMENT-SIGNATURE` header. The middleware also accepts the legacy `X-PAYMENT`: `adapter.getHeader("payment-signature") || adapter.getHeader("x-payment")`.
5. Resource server → facilitator `POST /verify` with `{paymentPayload, paymentRequirements}`.
6. Facilitator decompiles and validates (rules below), resolves the payer key from the mirror node, verifies the signature (including threshold keys), and preflights balance + `payTo` association.
7. On `isValid`, the resource handler runs and produces the response body.
8. Middleware **buffers** that response and calls facilitator `POST /settle`.
9. Facilitator signs as fee payer, submits, and **awaits the receipt**: `await response.getReceipt(client)`. A non-SUCCESS status throws and returns `{success: false, errorReason: "transaction_failed"}`.
10. On success the middleware sets a `PAYMENT-RESPONSE` header (`success`, `payer`, `transaction`, `network`) and flushes the buffered response. On failure it **replaces** the response with a 402. Client-side, `getPaymentSettleResponse(...)` in `@x402/fetch` decodes the header.

### What is and is not asynchronous

Worth stating precisely, because it is easy to assume otherwise. In `@x402/express@2.19.0` and `@x402/hono@2.19.0`, settlement is **awaited before the buyer sees anything**. Hono nulls `c.res`, awaits `processSettlement`, and reassigns; Express overrides `res.end`, buffers the chunks, and awaits settlement before writing. Combined with `getReceipt` in the Hedera signer, the chain is: handler runs → response buffered → transaction submitted → Hedera receipt received → response flushed.

For Prism this is good news twice over. The split is real by the time the buyer is served, and any custom-fee failure surfaces as a 402 rather than a silent loss.

### Where the spec constrains the design

| Rule | Constraint | Effect on Prism |
|---|---|---|
| 1 — Transaction layout | Must be a `TransferTransaction` **directly**, not wrapped in `ScheduleCreateTransaction` or anything else | Kills scheduled transactions, HIP-423, and any batching |
| 1 — Transaction layout | *"Contain **only** transfer operations... necessary to implement the requested payment"* | Kills memo tricks, extra ops, piggybacked messages |
| 1 — Sums | Net HBAR sum = 0; net asset sum = 0 | Enforced on the signed body only |
| 2 — Fee payer safety | Fee payer must not be negative; **may** be positive *"for example when collecting fees or custom fee distributions"* | The clause that explicitly anticipates this design |
| 3 — Asset | Exactly one token id, or `"0.0.0"` for HBAR. For HTS payments, **any** HBAR transfer in the list is rejected | You cannot bundle an HBAR-denominated share into the signed list |
| 5 — Amount exactness | Net to `payTo` must equal `amount` exactly; *"No additional positive net transfers to any other party (besides `payTo`) may exist"* | **The rule that forces the design.** Application-layer splitting is prohibited |

Implementation reality, from `ExactHederaScheme.validateTransferSemantics`, verified in the 2.19.0 bundle: it decodes with `Transaction.fromBytes`, reads `transaction.hbarTransfers` / `transaction.tokenTransfers`, sums `netToPayTo`, and calls `getPositiveReceivers(payerTransfers)` — rejecting with `invalid_exact_hedera_payload_extra_positive_transfers` if any positive receiver is not `payTo`, and `invalid_exact_hedera_payload_amount_mismatch` if the net differs. **All of these read the client-signed body.** Custom fees are not in it. That establishes that every current implementation accepts the construction — which is a claim about code, verified twice on-chain. It does not establish that the specification's authors intended it: applying Rule 5's amount-exactness to the ledger outcome rather than to the signed transfer list gives the opposite reading. See the README's "honest position on Rule 5".

### Facilitators

| | x402.org | blocky402 | self-hosted |
|---|---|---|---|
| Endpoint | `https://x402.org/facilitator` | `https://api.testnet.blocky402.com` | `hedera-dev/scaffold-hbar`, branch `templates/x402-pay-per-use`, `facilitator/src/server.ts` |
| Hedera fee payer | `0.0.9185802` | `0.0.7162784` | your own |
| Hedera kinds | `exact` only | `exact` only | `exact` |
| Non-Hedera kinds | Base, Solana, Algorand, Aptos, Stellar; `upto` and `batch-settlement` on Base only | Polygon Amoy, Solana | — |

All verified live 2026-07-27. The scaffold facilitator is a thin wrapper — it imports `ExactHederaScheme` from `@x402/hedera/exact/facilitator` and `x402Facilitator` from `@x402/core/facilitator`, and exposes `GET /supported`, `POST /verify`, `POST /settle`, plus `GET /health`. Its own comment: *"It is non-custodial: it can only add its fee-payer signature to a transfer the buyer already authorized."* It defaults to `aliasPolicy: "reject"`, requiring `payTo` to be a concrete account id rather than an EVM alias — the spec permits either, and warns that allowing aliases lets a resource server make the facilitator fund account creation.

Of the 11 payment kinds the canonical facilitator advertises, **Hedera has exactly one**: `exact`. No `upto`, no `batch-settlement`. Prism must work inside that one scheme, unmodified.

---

## 9. HIP-991: explained properly, and why it is not the mechanism

HIP-991 is **Final**, shipped in release **0.59.5**. It lets an HCS topic charge a fee to submit a message, in HBAR or an HTS fungible token, governed by a new Fee Schedule Key, with a Fee Exempt Key List of up to `MAX_ENTRIES_FOR_FEE_EXEMPT_KEY_LIST = 10` keys whose holders post free. Fees are *"distributed similarly to fixed fees on the HTS, supporting multiple wallets and Fungible tokens in addition to HBAR"* — up to `MAX_CUSTOM_FEE_ENTRIES_FOR_TOPICS = 10` entries. Threshold keys work in the exempt list. If a topic is created without a Fee Schedule Key, one cannot be added later — the same one-way door as tokens. A submitter can cap exposure with `max_custom_fees`; exceeding it fails with `MAX_CUSTOM_FEE_LIMIT_EXCEEDED` (382).

This is a genuine micropayment primitive **at the consensus layer**, with no EVM equivalent. No other chain lets you charge for a log write at the protocol level. Hedera publishes `hedera-dev/tutorial-js-hip-991-ai-agent` framing it explicitly as a way to empower AI agents. The economic constraint to be aware of: the `ConsensusSubmitMessage` base price rose from $0.0001 to $0.0008 USD in January 2026 with the v0.69 release, per the note in HIP-991 itself.

**So why is it not Prism's mechanism?** Because HIP-991 topic fees are **fixed only**. Directly from `custom_fees.proto`, on `FixedCustomFee`:

> *"Only 'fixed' fee definitions are supported because there is no basis for a fractional fee on a consensus submit transaction."*

A percentage refraction of a variable payment cannot be expressed as a fixed per-message fee. HIP-991 charges for *writing*; Prism divides a *payment*. They are different primitives that happen to share the phrase "custom fee".

It remains available as a complementary rail — a paid audit log where each Prism settlement is written to a revenue-generating topic, monetising the receipt trail itself and using HCS's consensus-computed `running_hash` for tamper-evidence without inventing a `prevHash` field. That is a real option, not the core. Adding it would be additive; claiming it as the split mechanism would be false.

---

## 10. Deliberately not used

| Capability | Why not |
|---|---|
| **Smart contracts (HSCS/EVM)** | The entire claim is that no contract exists. A contract anywhere in the payment path forfeits the argument. |
| **Scheduled transactions / HIP-423** | Categorically forbidden: *"It MUST NOT be wrapped in a `ScheduleCreateTransaction` or any other transaction type."* Not a preference — a spec violation. |
| **HIP-336 allowances / approvals** | The `exact` scheme wants a direct, client-signed transfer whose signature the facilitator verifies against the payer's own key. An approval introduces a spender whose authority the facilitator would have to reason about separately, for no gain. |
| **HIP-991 topic fees as the split** | Fixed fees only; cannot express a percentage. See §9. Optional as a receipt log. |
| **NFTs / royalty fees** | `RoyaltyFee` is NFT-only. Prism settles in a fungible token. Fractional fees are explicitly fungible-only. |
| **`upto` / `batch-settlement` schemes** | Not advertised for Hedera by either public facilitator. Only `exact` exists here. |
| **HCS-10 / HCS-11 / HCS-25 / HCS-26** | Agent registry, agent card, x402 trust signal, and skills registry. Adjacent and interesting, and a different product. HCS-25's x402 adapter also has a known weakness — volume and trade counts are trivially wash-traded — so building a claim on it would be weak. *These four were not re-verified in this pass; treat their details as inherited from the prior research.* |
| **Custom / self-hosted facilitator as the primary path** | Running your own facilitator lets you relax any check you want, which proves nothing about interoperability. Prism runs against unmodified public facilitators. Self-hosting is a fallback, and the scaffold-hbar server exists if it is needed. |
| **`hiero-cli` x402 plugin** | Reported to exist on GitHub `main` but **not in the published npm tag**. Not verified in this pass; do not build on it. |

---

## 11. Failure modes — what the empirical checks actually returned

Everything in this section was originally an open question. All of it has now been
run on Hedera testnet. Resolved items keep their original framing so the reasoning
stays legible, with the observed answer recorded.

| # | Question | Answer, observed |
|---|---|---|
| 1 | Does a fee-bearing transfer pass **both** public facilitators? | **Yes, both.** x402.org → `0.0.9185802-1785181090-410250982`, blocky402 → `0.0.7162784-1785181097-148987684`. Each returned `isValid: true` then `success: true`, and each settled with `assessed_custom_fees` populated. Tested separately; neither was inferred from the other. |
| 2 | `net_of_transfers` — which side absorbs the fee? | **The receiver, under `Inclusive`.** `effective_payer_account_ids` named the recipient, exactly as the protobuf predicted. Prism ships `Inclusive` so the buyer is debited precisely what the 402 quoted. |
| 3 | Preflight blind spot with `net_of_transfers = true` | **Not reachable in Prism**, because choosing `Inclusive` means the payer never needs `amount + fee`. The gap in `createHederaPreflightTransfer` is real but only bites exclusive-fee designs. |
| 4 | Collector association revoked or slots exhausted | Collectors are created with `maxAutomaticTokenAssociations: -1`, which satisfied the requirement at token-create time. The create → associate → `TokenFeeScheduleUpdate` fallback was written and never needed. |
| 5 | Payee count exceeding the balance-adjustment ceiling | Not approached. Prism's transfer produces four adjustments (payer, `payTo`, two collectors) against a limit of 20. |
| 6 | Fee payer hardcoded and the facilitator rotates | Avoided by construction: the client reads `extra.feePayer` from every 402. The two public facilitators do use different accounts, confirming the hazard was real. |
| 7 | Threshold-key payer fails signature verification | **It does not.** Agent `0.0.9795796` is a `KeyList` with threshold 2 and both facilitators verified it, returning `payer: 0.0.9795796`. Mirror node reports its key type as `ProtobufEncoded`. Pins held at `@hiero-ledger/sdk` 2.85.0 / `@hiero-ledger/proto` 2.31.0. |
| 8 | Min/max ordering silently flattening the percentage | Sidestepped — Prism sets neither `min` nor `max`, so `fractional_amount` always governs. |
| 9 | The "is this a real payment?" objection | Partly answered by the HBAR control route, which runs the same service through the same facilitator in a bounty-named asset. The rest is disclosure: the 402 declares every payee, and `/v1/audit/:txId` lets anyone recompute the split from public data. |
| 10 | Mirror-node lag between receipt and queryable record | Real and routine. Every read path retries with backoff; the settlement hook polls briefly and reports `indexed: false` rather than claiming no split occurred. |

### Two things the documentation did not warn about

Both cost a failed run and neither appears in the HIPs or SDK docs:

- **A fee collector must sign `TokenCreateTransaction`.** Naming an account in
  `feeCollectorAccountId` is not enough — it has to consent, or the network returns
  `INVALID_SIGNATURE`. This is separate from, and additional to, the
  `TOKEN_NOT_ASSOCIATED_TO_FEE_COLLECTOR` (235) association rule. The same applies
  to `TokenFeeScheduleUpdateTransaction`.
- **The mirror node returns `effective_payer_account_ids`** — a plural array —
  where `custom_fees.proto` describes a singular `effective_payer_account_id`.
  Reading the singular name yields `undefined` on an otherwise correct record.

- **A fee collector cannot send to a non-exempt account.** Under `Inclusive`
  assessment the *receiver* is the effective payer, so the fee must come out of
  the receiver's credit and route to the collectors. When the sender is itself a
  collector, that would have the network pay a collector a fee on a payment it
  is making, and it refuses the whole transfer with `FAIL_INVALID` — a status
  that says nothing about the cause. Measured on one token, same amount, same
  moment:

  | sender | receiver | result |
  |---|---|---|
  | non-collector | non-collector | `SUCCESS`, both fees assessed |
  | collector | collector | `SUCCESS`, no fees, exemption applies |
  | collector | non-collector | **`FAIL_INVALID`** |

  The consequence is architectural rather than cosmetic: **a fee collector is
  structurally a terminal payee.** A design that has a collector forward value
  onward cannot work, whatever the exemption flags say. That is consistent with
  what a revenue split is for, since every payee in one is terminal, but it has
  to be known before the token is minted rather than discovered after.

### The original checklist



| # | Failure mode / open question | Signal | The check that settles it |
|---|---|---|---|
| 1 | Does a fee-bearing transfer actually pass **both** public facilitators? The reference code says yes, but the spec permits stricter policy on top | `invalid_exact_hedera_payload_*` from `/verify` | Send one real payment in the fee-bearing token through `x402.org/facilitator` **and** `api.testnet.blocky402.com`. Do not infer one from the other |
| 2 | `net_of_transfers` — which side absorbs the fee, and does `payTo` land the quoted amount? | Mirror node `token_transfers` vs `assessed_custom_fees` | Settle once with `false` and once with `true`; read `effective_payer_account_id` in each record. The protobuf predicts receiver and sender respectively — confirm it |
| 3 | **Preflight blind spot.** With `net_of_transfers = true` the payer needs `amount + fee`, but `createHederaPreflightTransfer` only checks `amount` | Verify passes, settle fails `INSUFFICIENT_SENDER_ACCOUNT_BALANCE_FOR_CUSTOM_FEE` (259) | Fund a payer with exactly `amount` and settle. Expect a 402 at the client, not a silent partial |
| 4 | A fee collector's association is revoked or its auto-association slots fill after token creation | Settlement failure at consensus | Association is enforced at token creation (235), but re-check collector state before a demo. Preflight never looks at collectors |
| 5 | Payee count exceeds the balance-adjustment ceiling | `CUSTOM_FEE_CHARGING_EXCEEDED_MAX_ACCOUNT_AMOUNTS` (258) | Count adjustments — payer debit, `payTo` credit, one per collector, plus extras under `net_of_transfers` — against the limit of 20, not against the 10-fee limit |
| 6 | Fee payer hardcoded and the facilitator rotates or is swapped | `invalid_exact_hedera_payload_fee_payer_mismatch` | Read `extra.feePayer` from every 402. `getExtra()` picks randomly from the facilitator's addresses; the two public facilitators differ |
| 7 | Threshold-key payer fails signature verification | `signature_unverifiable`, message naming `Key._fromProtobufKey` | Pin `@hiero-ledger/sdk` (~2.85) and `@hiero-ledger/proto` (2.31.0) to the versions `@x402/hedera` depends on, then verify with a real `ThresholdKey` account |
| 8 | Min/max ordering silently flattens the percentage | Fee is constant regardless of amount | Set `maximum_amount > minimum_amount`, or leave both 0. The protobuf warns that `max <= min` makes `fractional_amount` inert |
| 9 | The "is this a real payment?" objection about a self-minted token | Judgment, not an error code | Prove it: supply key present, non-treasury balances, shares landing in accounts the operator does not control, all on the mirror node. Optionally run the same service on a plain HBAR or USDC route with the split off |
| 10 | Mirror node lag between receipt and queryable record | Empty or stale `/transactions/{id}` | Retry with backoff. Do not treat the first 404 as failure |

---

## Sources

Verified 2026-07-27:

- x402 spec — `specs/schemes/exact/scheme_exact_hedera.md`, [coinbase/x402](https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_hedera.md)
- Published bundles — `@x402/hedera`, `@x402/core`, `@x402/express`, `@x402/hono`, `@x402/fetch` at **2.19.0**; `@x402/hedera` depends on `@hiero-ledger/sdk` 2.85.0 and `@hiero-ledger/proto` 2.31.0
- Hiero consensus node protobufs — `services/custom_fees.proto`, `services/response_code.proto`
- HIPs — [991](https://github.com/hiero-ledger/hiero-improvement-proposals/blob/main/HIP/hip-991.md) (Final, 0.59.5), [18](https://github.com/hiero-ledger/hiero-improvement-proposals/blob/main/HIP/hip-18.md) (Final, v0.16.0, superseded by 573), [573](https://github.com/hiero-ledger/hiero-improvement-proposals/blob/main/HIP/hip-573.md) (Final, v0.31.0), [423](https://github.com/hiero-ledger/hiero-improvement-proposals/blob/main/HIP/hip-423.md) (Final, v0.57.0), [336](https://github.com/hiero-ledger/hiero-improvement-proposals/blob/main/HIP/hip-336.md) (Final, v0.25.0)
- Live endpoints — `GET https://x402.org/facilitator/supported`, `GET https://api.testnet.blocky402.com/supported`, Hedera testnet mirror node
- Reference facilitator — [hedera-dev/scaffold-hbar](https://github.com/hedera-dev/scaffold-hbar/blob/templates/x402-pay-per-use/facilitator/src/server.ts), branch `templates/x402-pay-per-use`
- Prior art — [MiroShark/x402aff](https://github.com/MiroShark/x402aff), created 2026-07-13, pushed 2026-07-24, MIT, 3 stars
- Bounty text — `bounty.md` / `x402-bounty.md` in scaffold-hbar

Not re-verified in this pass and inherited from prior research: HCS-10/11/25/26 details, the `hiero-cli` x402 plugin's publication status, the prior-winner statistics (0 of 6 `KeyList`, 3 of 5 broken HTS claims), and the scheduled-transaction `wait_for_expiry` usage figure.
