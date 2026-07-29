/** @type {import('next').NextConfig} */
const nextConfig = {
  // stellar-web-sdk ships modern ESM; let Next transpile it for the client bundle.
  transpilePackages: ['stellar-web-sdk'],

  webpack: (config) => {
    // @stellar/stellar-sdk pulls in the Node-native `sodium-native` addon (via `require-addon`)
    // for fast ed25519 signing. webpack can't statically analyze its dynamic `require`, which spams
    // "Critical dependency" warnings. stellar-base only uses it when `window` is undefined and
    // otherwise falls back to pure-JS tweetnacl — and its Node path bails to the same fallback when
    // the module resolves empty. So alias the native addon away in the bundle; signing still works.
    config.resolve.alias = {
      ...config.resolve.alias,
      'sodium-native': false,
      'require-addon': false
    }
    return config
  }
}

export default nextConfig
