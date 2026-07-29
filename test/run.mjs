// Minimal dependency-free test runner: runs each *.test.mjs as a child process and aggregates.
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const files = readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort()

let failed = 0
for (const f of files) {
  console.log(`\n=== ${f} ===`)
  const res = spawnSync(process.execPath, [join(here, f)], { stdio: 'inherit' })
  if (res.status !== 0) failed++
}
console.log(`\n${files.length - failed}/${files.length} test files passed`)
process.exit(failed ? 1 : 0)
