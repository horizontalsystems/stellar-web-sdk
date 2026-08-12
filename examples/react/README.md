# stellar-web-sdk — React example

The swap lifecycle driven by the **React hooks** (`stellar-web-sdk/react`) in a plain React app —
no Next.js. Bundled for the browser with esbuild.

## Run

```sh
# from the repo root — build the SDK incl. the React entry first
npm install
npm run build:all      # emits dist/ AND dist/react (the hooks this example imports)

cd examples/react
npm install
npm run dev            # bundles + serves at http://localhost:5174
```

Open <http://localhost:5174> and click **Get quote** — quoting needs no key at all. Both key fields
are optional: a Soroswap key (`sk_…`) lets that one provider quote, and a StellarBroker partner key
is needed only to commit an SB route. Either can also come from the repo-root `.env`. To run a real
swap, add a funded mainnet account's **secret key**, then Quote → Activate trustline (if prompted)
→ Swap.

> Build `dist/react` first (`npm run build:all` at the root) — the default `npm run build` only emits
> the framework-agnostic core.

## Structure

```
public/              # served web root (static)
  index.html
  styles.css
  app.bundle.js      # esbuild output (git-ignored)
src/
  main.jsx           # entry — createRoot(<App/>)
  App.jsx            # API config + builds the SDK, mounts <StellarSwapProvider>
  components/
    Swap.jsx         # the swap panel (hooks)
    Note.jsx         # coloured status paragraph
  lib/
    constants.js     # asset + default-URL constants
scripts/
  build.mjs          # esbuild bundle (jsx: automatic) → public/app.bundle.js
  serve.mjs          # static server for public/
  buffer-shim.js     # Buffer/process shim injected into the bundle
```

`App.jsx` shares one SDK via `<StellarSwapProvider>`; `Swap.jsx` uses `useQuote()` (best-price quote),
`useStellarSwap()` (trustline gate), `useExecuteSwap()` (commit → execute → track with live broker
state), and `useTrackStatus()` (poll to a terminal status). Same flow as the
[Next.js example](../nextjs), minus the App Router — showing the hooks work in any React setup.

## Notes

- **Mainnet only** — a swap moves real funds. Use a dedicated, low-balance account; the pasted secret
  key is wrapped as a `keypairSigner` and stays in the page. Provider keys are entered in the UI; in
  production leave `credentials` unset and point `config.fetch` at your own proxy so the keys stay
  server-side.
- esbuild bundles JSX (`jsx: 'automatic'`) and, with `preserveSymlinks`, resolves `react` + the linked
  `stellar-web-sdk` from this example's `node_modules`. `@stellar/stellar-sdk` needs the `Buffer` shim
  (`scripts/buffer-shim.js`).
