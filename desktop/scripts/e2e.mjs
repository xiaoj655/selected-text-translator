import { runE2E } from './e2e/runner.mjs'

await runE2E(process.argv.includes('--visual') ? 'visual' : process.argv.includes('--all') ? 'all' : 'core')
