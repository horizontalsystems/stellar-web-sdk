// Bundle the vanilla example (stellar-web-sdk + @stellar/stellar-sdk) into public/ with esbuild.
import { build, context } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineEntries, describeEnv } from '../../load-env.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const watch = process.argv.includes('--watch')

const options = {
  entryPoints: [join(root, 'src/main.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  outfile: join(root, 'public/app.bundle.js'),
  inject: [join(root, 'scripts/buffer-shim.js')],
  // Credentials come from the repo-root .env (see examples/load-env.mjs). They are compiled
  // into the browser bundle, which is fine for a local demo and wrong for production.
  define: { global: 'globalThis', ...defineEntries() },
  // Resolve deps from THIS example's node_modules even though stellar-web-sdk is a symlink.
  preserveSymlinks: true,
  sourcemap: true,
  logLevel: 'info'
}

if (watch) {
  const ctx = await context(options)
  await ctx.watch()
  console.log('esbuild watching examples/vanilla…')
} else {
  await build(options)
}

console.log(`\ncredentials from the repo-root .env:\n${describeEnv()}\n`)
