import { spawnSync } from 'node:child_process'

const resolutions = [
  '3840x2160x24',
]

const requested = process.argv.slice(2).filter((arg) => /^\d+x\d+x\d+$/u.test(arg))
const targets = requested.length ? requested : resolutions
const script = new URL('./e2e.mjs', import.meta.url).pathname

let failed = 0
for (const screen of targets) {
  console.log(`[e2e] === layout at ${screen} ===`)
  const result = spawnSync(process.execPath, [script, '--layout'], {
    stdio: 'inherit',
    env: { ...process.env, STT_E2E_SCREEN: screen },
  })
  if (result.status !== 0) failed += 1
}

if (failed) {
  console.error(`[e2e] layout failed at ${failed}/${targets.length} resolution(s)`)
  process.exit(1)
}
console.log(`[e2e] layout passed at ${targets.length} resolution(s)`)
