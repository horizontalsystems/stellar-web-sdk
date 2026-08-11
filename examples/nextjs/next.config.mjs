import { loadExampleEnv } from '../load-env.mjs'

// All three examples read the SAME repository-root .env, so credentials live in one place. Next
// only inlines vars it knows at build time, so they are mapped onto NEXT_PUBLIC_* here rather than
// duplicated into examples/nextjs/.env.local.
const example = loadExampleEnv()

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_SOROSWAP_API_KEY: example.soroswapApiKey,
    NEXT_PUBLIC_STELLARBROKER_PARTNER_KEY: example.stellarBrokerPartnerKey,
    NEXT_PUBLIC_NEAR_API_JWT: example.nearApiJwt,
    NEXT_PUBLIC_VALIDATION_CLOUD_API_KEY: example.validationCloudApiKey,
    NEXT_PUBLIC_VALIDATION_CLOUD_HOST: example.validationCloudHost
  },

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
