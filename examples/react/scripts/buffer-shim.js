// esbuild --inject shim: expose Buffer + a minimal process/global for @stellar/stellar-sdk
// so the SDK bundle runs in the browser without a full node polyfill.
import { Buffer as BufferPolyfill } from 'buffer'
export const Buffer = BufferPolyfill
export const global = globalThis
export const process = { env: {}, browser: true, version: '', nextTick: (cb, ...a) => queueMicrotask(() => cb(...a)) }
