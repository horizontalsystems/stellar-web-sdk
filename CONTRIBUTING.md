# Contributing

Bug reports and integration feedback are the most useful things you can send. This document exists
so that a report arrives with enough in it to act on.

## Getting the SDK running

```sh
git clone https://github.com/horizontalsystems/stellar-web-sdk
cd stellar-web-sdk
npm install        # compiles dist/ automatically via the prepare script
npm test           # 65 offline tests, no network, no credentials
```

`npm test` needs nothing from you — no keys, no network, no running service. If it fails on a clean
clone, that alone is a complete bug report.

To consume the SDK from another project before it is on npm:

```sh
npm install github:horizontalsystems/stellar-web-sdk @stellar/stellar-sdk
```

## Credentials

The SDK has no backend and no key of its own. Every key belongs to an upstream venue and is passed
to the constructor. You can do a great deal without any of them:

| What you want to do | What you need |
|---|---|
| Run the test suite | nothing |
| Quote on Aquarius, STELLAR_DEX, StellarBroker | nothing |
| Quote on Soroswap | `soroswapApiKey` |
| Commit a StellarBroker session | `stellarBrokerPartnerKey` |
| Raise 1Click rate limits | `nearApiJwt` (optional) |
| Avoid public-endpoint rate limiting under fan-out | `validationCloud.apiKey` (optional) |

Never paste a key into an issue. If a key is implicated, say which one and what the error was.

## Filing an issue

Use one of the [issue templates](https://github.com/horizontalsystems/stellar-web-sdk/issues/new/choose):

- **Bug report** — something behaves incorrectly or throws.
- **Integration feedback** — the API was confusing, undocumented, or awkward to use. This is not a
  lesser category. An API that is technically correct and still hard to adopt is a real defect, and
  it is the kind we are least able to see from the inside.

What makes a report actionable:

- **The pair and amount.** Routing behaviour is pair-specific — a bug on `XLM → USDC` often does not
  reproduce on a thin pair, and vice versa.
- **Which provider(s).** The fan-out returns per-provider errors; naming the provider narrows the
  search from six adapters to one.
- **The full error.** `StellarSwapError` carries a `code` and usually a `provider`. Include both.
- **Whether it reproduces.** Quotes move with live liquidity. "Once" and "every time" lead to
  different investigations, so please say which.

## Things worth knowing before you report them

These are known and documented, not bugs:

- **StellarBroker routes have `minBuyAmount === null`.** The broker re-quotes live inside its
  session, so there is no client-verifiable floor. Every other provider enforces one on-chain.
- **StellarBroker is mainnet-only.** There is no testnet deployment.
- **A split StellarBroker fill reports a lower bound.** SB may spread a large order over several
  transactions in one ledger; a single hash covers only its own share. The session result carries
  the true totals.
- **A quote succeeds if any one provider answers.** Some providers declining is normal operation,
  surfaced as per-provider errors, not a failed quote.
- **Asset codes are case-sensitive** end to end and are never normalized.

## Changes

Run `npm test` and `npm run typecheck` before opening a pull request. The test suite is offline and
dependency-free by design — please keep it that way; a test that needs the network is a test that
will fail for someone else for reasons unrelated to their change.
