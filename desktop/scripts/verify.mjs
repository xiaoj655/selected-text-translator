import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
assert.match(pkg.version, /^\d+\.\d+\.\d+$/u, 'version must be semver')

const files = ['src', 'translator', 'scripts'].flatMap((name) => {
  const dir = join(root, name)
  return readdirSync(dir, { recursive: true }).map((file) => join(dir, file))
}).filter((file) => ['.js', '.mjs', '.cjs'].includes(extname(file)))

for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' })
}

execFileSync(process.execPath, [join(root, 'scripts', 'release-notes.mjs'), pkg.version], { stdio: 'pipe' })
execFileSync(process.execPath, [join(root, 'scripts', 'sync-src.mjs')], { stdio: 'inherit' })
execFileSync(process.execPath, [join(root, 'scripts', 'smoke.mjs')], { stdio: 'inherit' })
console.log(`[verify] ok  v${pkg.version}  ${files.length} source files`)
