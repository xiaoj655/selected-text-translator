import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
assert.match(pkg.version, /^\d+\.\d+\.\d+$/u, 'version must be semver')

function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name)
    if (statSync(file).isDirectory()) collect(file, out)
    else if (['.js', '.mjs', '.cjs'].includes(extname(file))) out.push(file)
  }
  return out
}

const files = [...collect(join(root, 'src')), ...collect(join(root, 'app')), ...collect(join(root, 'scripts'))]
for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
}

execFileSync(process.execPath, [join(root, 'scripts', 'sync-src.mjs')], { stdio: 'pipe' })
execFileSync(process.execPath, [join(root, 'scripts', 'smoke.mjs')], { stdio: 'pipe' })

const appSource = readFileSync(join(root, 'app', 'app.js'), 'utf8')
const htmlSource = readFileSync(join(root, 'app', 'index.html'), 'utf8')
const mainSource = readFileSync(join(root, 'src', 'main.js'), 'utf8')
assert.match(htmlSource, /id="input"/u, 'composer input is required')
assert.match(appSource, /START_TRANSLATION/u, 'app must drive the translation protocol')
assert.match(appSource, /onSelection/u, 'app must accept hotkey payloads')
assert.match(mainSource, /showMainWindow/u, 'hotkey must always reveal the main window')
assert.ok(existsSync(join(root, 'app', 'app.css')), 'stylesheet is required')
assert.ok(existsSync(join(root, 'src', 'history.js')), 'history persistence is required')
assert.match(mainSource, /createHistory/u, 'history must be wired into the main process')
assert.match(appSource, /loadHistory/u, 'app must restore history')

console.log(`[verify] ok  v${pkg.version}  ${files.length} source files`)
