# stellar-web-sdk — vanilla JS example

The swap lifecycle wired to the **core** `StellarSwapSDK` with plain DOM — no framework. Bundled
for the browser with esbuild.

## Run

```sh
# from the repo root — build the SDK first
npm install
npm run build          # emits dist/ (the core entry this example imports)

cd examples/vanilla
npm install
npm run dev            # bundles + serves at http://localhost:5173
```

Open <http://localhost:5173> and click **Get quote** — quoting needs no key at all. Both key fields
are optional: a Soroswap key (`sk_…`) lets that one provider quote, and a StellarBroker partner key
is needed only to commit an SB route. Either can also come from the repo-root `.env`. To run a real
swap, add a funded mainnet account's **secret key** (see below), then Quote → Activate trustline (if
prompted) → Swap.

Other scripts: `npm run build` (bundle only, into `public/`), `node scripts/build.mjs --watch`
(rebuild on change), `node scripts/serve.mjs 8080` (custom port).

## Structure

```
public/          # served web root (static)
  index.html
  styles.css
  app.bundle.js  # esbuild output (git-ignored)
src/
  main.js        # entry — reads the form, drives the flow
  sdk.js         # SDK/signer construction (the only module importing stellar-web-sdk)
  ui.js          # DOM note + error helpers
scripts/
  build.mjs      # esbuild bundle → public/app.bundle.js
  serve.mjs      # static server for public/
  buffer-shim.js # Buffer/process shim injected into the bundle
```

`src/main.js` uses the SDK directly: `sdk.quote()` → `sdk.checkTrustline()` / `sdk.activateTrustline()`
→ `sdk.commit()` → `sdk.execute()` (with live StellarBroker callbacks) → `sdk.pollTrack()` to a
terminal status.

## Notes

- **Mainnet only** — StellarBroker has no testnet, so a swap moves real funds. Use a dedicated,
  low-balance account; the pasted secret key is wrapped as a `keypairSigner` and stays in the page.
  Provider keys are entered in the UI and only used to construct the SDK in the browser — for
  production, leave `credentials` unset and point `config.fetch` at your own proxy so the keys stay
  server-side.
- Bundling `@stellar/stellar-sdk` for the browser needs a `Buffer` shim (`scripts/buffer-shim.js`,
  injected by esbuild). `preserveSymlinks` makes esbuild resolve deps from this example's
  `node_modules` even though `stellar-web-sdk` is linked via `file:../..`.
