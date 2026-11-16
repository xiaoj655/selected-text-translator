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
assert.match(htmlSource, /id="settings-panel"/u, 'in-app settings panel is required')
assert.match(appSource, /START_TRANSLATION/u, 'app must drive the translation protocol')
assert.match(appSource, /onSelection/u, 'app must accept hotkey payloads')
assert.match(appSource, /openSettings/u, 'settings must be reachable in-app')
assert.match(appSource, /renderDiagnostics/u, 'diagnostics must be visible')
assert.match(htmlSource, /id="btn-log"/u, 'log access is required')
assert.match(htmlSource, /id="opt-always-on-top"/u, 'window flags are required')
assert.match(appSource, /setAlwaysOnTop/u, 'window flags must be wired')
assert.match(appSource, /setCaptureMode/u, 'capture mode must be configurable')
assert.match(htmlSource, /id="cfg-hotkey"/u, 'custom hotkey must be configurable')
assert.match(appSource, /CANCEL_TRANSLATION/u, 'in-flight requests must be cancellable')
assert.match(appSource, /applyAppearance/u, 'appearance settings must be wired')
assert.match(htmlSource, /id="opt-theme"/u, 'theme selector is required')
assert.match(appSource, /empty-examples/u, 'empty state examples are required')
assert.match(mainSource, /ensureMainWindow/u, 'main window must be preloaded for instant hotkey response')
assert.match(mainSource, /showMainWindow/u, 'hotkey must always reveal the main window')
const preloadSource = readFileSync(join(root, 'src', 'preload.cjs'), 'utf8')
const windowsSource = readFileSync(join(root, 'src', 'windows.js'), 'utf8')
assert.match(preloadSource, /Object\.defineProperty\(window, 'chrome'/u, 'chrome shim must replace the built-in object')
assert.doesNotMatch(preloadSource, /contextBridge/u, 'preload must run in the main world')
assert.doesNotMatch(windowsSource, /contextIsolation: true/u, 'preload needs the main world')
assert.ok(existsSync(join(root, 'app', 'app.css')), 'stylesheet is required')
assert.ok(existsSync(join(root, 'src', 'history.js')), 'history persistence is required')
assert.match(mainSource, /createHistory/u, 'history must be wired into the main process')
assert.match(appSource, /loadHistory/u, 'app must restore history')
assert.ok(existsSync(join(root, 'app', 'card.html')), 'floating card window is required')
assert.ok(existsSync(join(root, 'app', 'card.js')), 'floating card renderer is required')
assert.ok(existsSync(join(root, 'app', 'card.css')), 'floating card stylesheet is required')
const cardSource = readFileSync(join(root, 'app', 'card.js'), 'utf8')
assert.match(cardSource, /START_TRANSLATION/u, 'card must drive the translation protocol')
assert.match(cardSource, /onSelection/u, 'card must accept hotkey payloads')
assert.match(cardSource, /reportEntry/u, 'card must sync finished entries to the main window')
assert.match(cardSource, /resizeCard/u, 'card must request auto-height resizing')
assert.match(cardSource, /missing-configuration/u, 'card must localize the missing-configuration error')
assert.match(mainSource, /showCardWindow/u, 'hotkey with captured text must open the floating card')
assert.match(mainSource, /stt:card-entry/u, 'card entries must reach the main window')
assert.match(mainSource, /stt:card-resize/u, 'card resize requests must reach the main process')
assert.match(preloadSource, /onCardEntry/u, 'main window must receive card entries')
assert.match(preloadSource, /resizeCard/u, 'preload must expose card resizing')
assert.match(appSource, /onCardEntry/u, 'app must merge card entries into history')
assert.match(appSource, /zh-CN/u, 'entry timestamps must use 24-hour zh-CN formatting')
assert.match(windowsSource, /globalShortcut\.register\('Escape'/u, 'Escape must close the card even when it is unfocused')
assert.match(windowsSource, /resizeCardWindow/u, 'main process must resize the card window')
const cardCss = readFileSync(join(root, 'app', 'card.css'), 'utf8')
assert.match(cardCss, /data-font/u, 'card must follow the font-size preference')
assert.match(cardCss, /data-motion/u, 'card must honor reduced motion')
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
assert.ok(changelog.split('\n').some((line) => line.startsWith(`## ${pkg.version}`)),
  `CHANGELOG.md must document v${pkg.version} (used for release notes)`)

console.log(`[verify] ok  v${pkg.version}  ${files.length} source files`)
