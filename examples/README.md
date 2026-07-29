# Examples

Each example runs the same swap lifecycle — quote → trustline gate → commit → execute → track — in a
different setup. All are **mainnet only** (StellarBroker has no testnet); use a dedicated,
low-balance account.

| Example | Stack | Uses | Serves on |
|---|---|---|---|
| [`vanilla`](vanilla) | Plain JS + esbuild | core `StellarSwapSDK` | `:5173` |
| [`react`](react) | React + esbuild | `stellar-web-sdk/react` hooks | `:5174` |
| [`nextjs`](nextjs) | Next.js App Router | `stellar-web-sdk/react` hooks | `:3000` |

Build the SDK from the repo root first — `npm run build` for the core (vanilla), or `npm run
build:all` to also emit `dist/react` (react + nextjs) — then follow each example's README.
