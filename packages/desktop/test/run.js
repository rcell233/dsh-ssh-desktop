/**
 * Run every desktop test file in its own process, in order.
 *
 * Run: node test/run.js
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const files = ['policy.js', 'platform.js', 'macos-ui.js', 'packaging.js', 'connections.js', 'smoke.js', 'installer.js']

let failed = 0
for (const file of files) {
  console.log(`\n== ${file}`)
  const result = spawnSync(process.execPath, [join(here, file)], { stdio: 'inherit' })
  if (result.status !== 0) failed += 1
}
if (failed > 0) {
  console.error(`\n${String(failed)} test file(s) failed`)
  process.exit(1)
}
console.log('\nall desktop test files passed')
