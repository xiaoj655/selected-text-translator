import { runE2E } from './e2e/runner.mjs'

const args = process.argv.slice(2)
const mode = args.includes('--visual') ? 'visual'
  : args.includes('--layout') ? 'layout'
    : args.includes('--input') ? 'input'
      : args.includes('--all') ? 'all' : 'core'

await runE2E(mode)
