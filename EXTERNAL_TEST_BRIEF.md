# External developer test — brief

A protocol for having a developer outside this project integrate the SDK cold, so that the friction
they hit is recorded rather than absorbed in a private conversation.

**This document is the protocol, not the result.** It describes a test to run. Until a named
developer has worked through it and filed issues, nothing here constitutes evidence that the test
happened.

## Why it is run this way

The people who wrote this SDK cannot evaluate whether it is adoptable. We know which argument is
required, which field is nullable and why, and where the sharp edges are — so we route around them
without noticing. The only way to find what a newcomer trips on is to watch a newcomer trip on it.

That makes the test's value depend almost entirely on one rule: **the tester works unaided.**

## Ground rules

1. **No live help during the test.** Questions go into a GitHub issue, not a chat. If the tester is
   truly blocked, they record the blockage, then ask — and the fact that asking was necessary is
   itself the finding.
2. **Report friction even when resolved.** "I worked it out after 20 minutes" is a defect report.
   The 20 minutes are the defect.
3. **Timebox each task.** When the box expires, stop and record where things stood. A task nobody
   finishes is a stronger result than one finished with help.
4. **Nothing is too small.** A confusing parameter name is in scope.

## Who it should be

A developer who writes TypeScript and has some blockchain exposure, but who has **not** worked on
this SDK. Familiarity with Stellar specifically is useful but not required —
if the SDK only works for people who already know Stellar, that is worth discovering.

## Setup

```sh
npm install stellar-web-sdk @stellar/stellar-sdk
```

Credentials are optional for most of this. Aquarius, STELLAR_DEX and StellarBroker quote without any
key; Soroswap needs `soroswapApiKey`. Provide keys only when a task calls for them, and note whether
their absence was clearly explained at the point of failure.

## Tasks

Each has a timebox. Record the actual time taken, whether it completed, and every point of
confusion along the way.

### 1 — First quote (20 min)

From a blank project, get a quote for `100 XLM → USDC` and print the expected output amount and
which provider won.

*Watching for:* does install-to-first-quote work from the README alone, without reading source?

### 2 — Read the alternatives (20 min)

Print every route the fan-out returned, with each provider's expected output and its `minBuyAmount`.
Then answer, in your own words: **why did the SDK pick the one it did**, and what does
`minBuyAmount: null` on the StellarBroker route mean for you as an integrator?

*Watching for:* is the selection rule discoverable, and is the null floor understood as "no
client-verifiable floor" rather than "no data"? This is the single most misreadable thing in the
API.

### 3 — Handle a failure (20 min)

Quote a pair that cannot route (an invented asset code is fine). Then quote with a deliberately
malformed amount.

*Watching for:* is the error legible? Does `StellarSwapError`'s `code`/`provider` tell you what to
do next, or only that something went wrong? Can you tell a per-provider decline apart from a total
failure?

### 4 — Execute (45 min, optional — costs real funds)

With a funded mainnet keypair, execute a small swap and confirm settlement on-chain.

Use a genuinely small amount. StellarBroker is **mainnet-only**, so there is no testnet path for
that provider.

*Watching for:* is the quote → commit → execute → track sequence clear? Is it obvious what must be
carried between steps, and when a trustline is needed?

### 5 — Track an outcome (20 min)

From an executed swap, report the amount that actually settled and compare it to the quote.

*Watching for:* is it clear that the settled amount is read from the chain rather than assumed, and
is the split-fill lower-bound caveat findable if you go looking?

### 6 — React (30 min, if relevant)

Build a component using `useQuote` from `stellar-web-sdk/react` that shows a live quote for a pair
chosen in a dropdown.

*Watching for:* do the hooks behave under re-render and unmount? Are the types usable without
casting?

### 7 — Cross-chain quote (20 min)

Quote a route that leaves Stellar, via NEAR or Axelar ITS.

*Watching for:* is it clear that these settle over minutes with different failure modes, rather than
in a single ledger?

## What to record

For each task: time taken, completed yes/no, every moment of confusion, and anything assumed that
turned out to be wrong. Wrong assumptions are the most valuable output — they map where the API's
shape misleads.

At the end, two questions:

- Would you choose this SDK for a real integration? Why, or why not?
- What is the single thing that most needs to change?

## Filing

One GitHub issue per distinct finding, using the
[templates](https://github.com/horizontalsystems/stellar-web-sdk/issues/new/choose) — **Bug report**
for incorrect behaviour, **Integration feedback** for friction. Batching everything into one issue
makes them impossible to close individually.

## Closing the loop

The test is not complete when the issues are filed. It completes when each issue is resolved or
explicitly declined with a reason, and **the tester re-runs the affected task against the updated
code and confirms the fix** — the retest leg. Link each fixing commit from its issue so the
Issue → feedback → commit → retest chain is readable end to end by someone who was not there.
