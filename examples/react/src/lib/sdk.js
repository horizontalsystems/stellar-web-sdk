// SDK construction for the React example — mirrors examples/vanilla/src/sdk.js.
import { StellarSwapSDK } from 'stellar-web-sdk'

// Compile-time constants injected from the repo-root .env (see examples/load-env.mjs). Declared
// with `typeof` guards so the module still loads if the bundle was built without them.
const ENV = {
  soroswapApiKey: typeof __SOROSWAP_API_KEY__ === 'string' ? __SOROSWAP_API_KEY__ : '',
  stellarBrokerPartnerKey: typeof __STELLARBROKER_PARTNER_KEY__ === 'string' ? __STELLARBROKER_PARTNER_KEY__ : '',
  nearApiJwt: typeof __NEAR_API_JWT__ === 'string' ? __NEAR_API_JWT__ : '',
  validationCloudApiKey: typeof __VALIDATION_CLOUD_API_KEY__ === 'string' ? __VALIDATION_CLOUD_API_KEY__ : '',
  validationCloudHost: typeof __VALIDATION_CLOUD_HOST__ === 'string' ? __VALIDATION_CLOUD_HOST__ : ''
}

/**
 * Every key goes straight into the SDK constructor — there is no URL-building or endpoint plumbing
 * to do here. The Validation Cloud key resolves to both the Horizon and Soroban RPC endpoints
 * inside the SDK; without it the public endpoints apply.
 *
 * Anything typed into the form overrides the corresponding .env value.
 */
export function createSdk({ soroswapApiKey, stellarBrokerPartnerKey } = {}) {
  const soroswap = soroswapApiKey || ENV.soroswapApiKey
  const broker = stellarBrokerPartnerKey || ENV.stellarBrokerPartnerKey
  return new StellarSwapSDK({
    credentials: {
      ...(soroswap ? { soroswapApiKey: soroswap } : {}),
      ...(broker ? { stellarBrokerPartnerKey: broker } : {}),
      ...(ENV.nearApiJwt ? { nearApiJwt: ENV.nearApiJwt } : {})
    },
    ...(ENV.validationCloudApiKey
      ? {
          validationCloud: {
            apiKey: ENV.validationCloudApiKey,
            ...(ENV.validationCloudHost ? { host: ENV.validationCloudHost } : {})
          }
        }
      : {})
  })
}

/** What the build injected, for the page to show without revealing the values. */
export const envStatus = {
  soroswap: !!ENV.soroswapApiKey,
  broker: !!ENV.stellarBrokerPartnerKey,
  rpc: ENV.validationCloudApiKey ? 'validation cloud' : 'public'
}
