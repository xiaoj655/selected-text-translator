import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
assert.match(pkg.version, /^\d+\.\d+\.\d+$/u, 'version must be semver')
assert.equal(pkg.build?.win?.icon, 'assets/icon.ico', 'Windows builds must use the ICO application icon')
assert.ok(existsSync(join(root, 'assets', 'icon.ico')), 'Windows ICO application icon is required')

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
execFileSync(process.execPath, [join(root, 'scripts', 'verify-icons.mjs')], { stdio: 'pipe' })
execFileSync(process.execPath, [
  '--test', join(root, 'scripts', 'tutor-smoke.mjs'), join(root, 'scripts', 'reading-sources.test.mjs'),
  join(root, 'scripts', 'reading-web.test.mjs'), join(root, 'scripts', 'history.test.mjs'),
  join(root, 'scripts', 'reading-content.test.mjs'), join(root, 'scripts', 'reading-media.test.mjs'),
  join(root, 'scripts', 'reading-selection.test.mjs'),
  join(root, 'scripts', 'reading-history.test.mjs'),
], { stdio: 'pipe' })

const appSource = readFileSync(join(root, 'app', 'app.js'), 'utf8')
const resultComponentSource = readFileSync(join(root, 'app', 'translation-result.js'), 'utf8')
const htmlSource = readFileSync(join(root, 'app', 'index.html'), 'utf8')
const mainSource = readFileSync(join(root, 'src', 'main.js'), 'utf8')

function appFunctionSource(name) {
  const start = appSource.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} function is required`)
  const end = appSource.indexOf('\nfunction ', start + 1)
  return appSource.slice(start, end === -1 ? undefined : end)
}

assert.match(htmlSource, /id="input"/u, 'composer input is required')
assert.match(htmlSource, /id="settings-panel"/u, 'in-app settings panel is required')
assert.ok(htmlSource.indexOf('class="composer"') < htmlSource.indexOf('class="stream"'),
  'input composer must precede the result stream in the DOM so visual, reading and tab order align')
assert.match(appSource, /START_TRANSLATION/u, 'app must drive the translation protocol')
assert.match(appSource, /onSelection/u, 'app must focus the composer when the main window opens')
assert.match(appSource, /openSettings/u, 'settings must be reachable in-app')
assert.match(appSource, /renderDiagnostics/u, 'diagnostics must be visible')
assert.match(htmlSource, /id="btn-log"/u, 'log access is required')
assert.match(htmlSource, /id="opt-always-on-top"/u, 'window flags are required')
assert.match(appSource, /setAlwaysOnTop/u, 'window flags must be wired')
assert.match(htmlSource, /id="btn-paste-translate"/u, 'clipboard paste-and-translate entry is required')
assert.match(appSource, /pasteAndTranslate/u, 'paste-and-translate must be wired')
assert.match(appSource, /readClipboard/u, 'paste-and-translate must read the system clipboard')
assert.match(htmlSource, /id="opt-live-translate"/u, 'live translation toggle is required')
assert.match(appSource, /function scheduleLiveTranslate/u, 'debounced live translation is required')
assert.match(appSource, /submit\(\{ keepInput: true \}\)/u, 'live translation must preserve the source text')
assert.match(htmlSource, /id="result-announcer"[^>]*aria-live="polite"/u,
  'completed translations need a polite live region for screen readers')
assert.match(appSource, /function announceResult/u, 'translated text must be announced to assistive tech')
assert.match(appSource, /announceResult\(entry\.mode === 'guide'/u, 'both completion routes must announce the result')
assert.match(appSource, /function cancelStaleRequests/u, 'superseded in-flight requests must be cancelled')
assert.match(appSource, /cancelStaleRequests\(entry\.id\)/u, 'a new submission must cancel stale requests')
assert.match(appFunctionSource('startCompanionEntry'), /cancelStaleRequests\(companion\.id\)/u,
  'starting a companion entry must cancel superseded in-flight requests')
assert.match(appFunctionSource('regenerate'), /cancelStaleRequests\(entry\.id\)/u,
  'regenerating must cancel superseded in-flight requests')
assert.match(appSource, /desktop_live_translate/u, 'live translation setting must be persisted')
assert.match(appSource, /function scheduleDraftSave/u, 'input draft must be autosaved with debounce')
assert.match(appSource, /function clearSavedDraft/u, 'sent or cleared input must clear the saved draft')
assert.match(appSource, /desktop_input_draft/u, 'draft must be persisted to local storage')
assert.match(appSource, /scheduleDraftSave\(\)/u, 'typing must schedule a draft save')
assert.doesNotMatch(appSource, /if \(!options\.keepInput\) \{[\s\S]{0,80}\$\('input'\)\.value = ''/u,
  'translating must keep the source text in the input for in-place editing')
assert.match(appSource, /function isNearBottom/u, 'scroll stickiness detection is required')
assert.match(appSource, /function followStreamBottom/u, 'streaming must respect scroll position')
assert.doesNotMatch(appSource, /patchStreamResult[\s\S]{0,600}stream\.scrollTop\s*=\s*stream\.scrollHeight/u,
  'stream patches must not force scroll to bottom')
assert.match(appSource, /CANCEL_TRANSLATION/u, 'in-flight requests must be cancellable')
assert.match(appSource, /applyAppearance/u, 'appearance settings must be wired')
assert.match(htmlSource, /id="opt-theme"/u, 'theme selector is required')
assert.match(appSource, /empty-examples/u, 'empty state examples are required')
assert.match(appSource, /if \(state\.configured\) submit\(\{ lookup: null \}\)/u,
  'examples must translate in one click without becoming tutor material')
assert.match(mainSource, /await windows\.showMainWindow\(\)/u, 'launch must open the main window')
assert.doesNotMatch(mainSource, /createCapture|createShortcuts/u, 'desktop launch must not register global selection')
assert.match(mainSource, /app\.setAppUserModelId\('io\.github\.xiaoj655\.selected-text-translator'\)/u,
  'Windows taskbar identity must match the packaged app id')
const preloadSource = readFileSync(join(root, 'src', 'preload.cjs'), 'utf8')
const windowsSource = readFileSync(join(root, 'src', 'windows.js'), 'utf8')
assert.match(preloadSource, /Object\.defineProperty\(window, 'chrome'/u, 'chrome shim must replace the built-in object')
assert.doesNotMatch(preloadSource, /contextBridge/u, 'preload must run in the main world')
assert.match(preloadSource, /remove\(keys\)/u, 'storage shim must expose remove for draft cleanup')
assert.match(mainSource, /op === 'remove'/u, 'main must handle storage remove operations')
assert.doesNotMatch(windowsSource, /contextIsolation: true/u, 'preload needs the main world')
assert.ok(existsSync(join(root, 'app', 'app.css')), 'stylesheet is required')
assert.ok(existsSync(join(root, 'src', 'history.js')), 'history persistence is required')
assert.match(mainSource, /createHistory/u, 'history must be wired into the main process')
assert.match(appSource, /loadHistory/u, 'app must restore history')
assert.ok(existsSync(join(root, 'app', 'card.html')), 'floating card window is required')
assert.ok(existsSync(join(root, 'app', 'card.js')), 'floating card renderer is required')
assert.ok(existsSync(join(root, 'app', 'card.css')), 'floating card stylesheet is required')
const cardSource = readFileSync(join(root, 'app', 'card.js'), 'utf8')
const sharedAnkiSource = readFileSync(fileURLToPath(new URL('../../src/anki-export.js', import.meta.url)), 'utf8')
const sharedLibrarySourceForAnki = readFileSync(fileURLToPath(new URL('../../src/library.js', import.meta.url)), 'utf8')
const sharedLibraryHtmlForAnki = readFileSync(fileURLToPath(new URL('../../src/library.html', import.meta.url)), 'utf8')
const sharedContractsSource = readFileSync(
  fileURLToPath(new URL('../../src/translation-contracts.js', import.meta.url)), 'utf8')
const sharedBackgroundSource = readFileSync(
  fileURLToPath(new URL('../../src/background.js', import.meta.url)), 'utf8')
const sharedArchiveSource = readFileSync(
  fileURLToPath(new URL('../../src/learning-archive.js', import.meta.url)), 'utf8')
const sharedMemorySource = readFileSync(
  fileURLToPath(new URL('../../src/translation-memory.js', import.meta.url)), 'utf8')
const sharedSourceLanguage = readFileSync(
  fileURLToPath(new URL('../../src/source-language.js', import.meta.url)), 'utf8')
const sharedGlossarySource = readFileSync(
  fileURLToPath(new URL('../../src/glossary.js', import.meta.url)), 'utf8')
const sharedSpeechSource = readFileSync(
  fileURLToPath(new URL('../../src/speech.js', import.meta.url)), 'utf8')
const desktopTtsSource = readFileSync(join(root, 'src', 'tts.js'), 'utf8')
const sharedProgressSource = readFileSync(
  fileURLToPath(new URL('../../src/vocabulary-progress.js', import.meta.url)), 'utf8')
const sharedLibraryHtml = readFileSync(
  fileURLToPath(new URL('../../src/library.html', import.meta.url)), 'utf8')
const sharedLibrarySource = readFileSync(
  fileURLToPath(new URL('../../src/library.js', import.meta.url)), 'utf8')
const sharedLibraryCss = readFileSync(
  fileURLToPath(new URL('../../src/library.css', import.meta.url)), 'utf8')
assert.match(cardSource, /START_TRANSLATION/u, 'card must drive the translation protocol')
assert.match(cardSource, /onSelection/u, 'the testable card must accept source text')
assert.match(cardSource, /reportEntry/u, 'card must sync finished entries to the main window')
assert.match(cardSource, /resizeCard/u, 'card must request auto-height resizing')
assert.match(cardSource, /missing-configuration/u, 'card must localize the missing-configuration error')
assert.match(mainSource, /stt:e2e:show-card/u, 'the test harness must be able to exercise the floating card')
assert.match(mainSource, /stt:card-entry/u, 'card entries must reach the main window')
assert.match(mainSource, /stt:card-resize/u, 'card resize requests must reach the main process')
assert.match(preloadSource, /onCardEntry/u, 'main window must receive card entries')
assert.match(preloadSource, /resizeCard/u, 'preload must expose card resizing')
assert.match(appSource, /onCardEntry/u, 'app must merge card entries into history')
assert.match(appSource, /toLocaleTimeString\('en', \{ hour12: false/u, 'entry timestamps must use English 24-hour formatting')
assert.match(windowsSource, /globalShortcut\.register\('Escape'/u, 'Escape must close the card even when it is unfocused')
assert.match(windowsSource, /resizeCardWindow/u, 'main process must resize the card window')
assert.match(windowsSource, /setCardPinned/u, 'main process must track the pinned card')
assert.match(cardSource, /setCardPinned/u, 'card must report pin changes')
assert.match(preloadSource, /setCardPinned/u, 'preload must expose card pinning')
const cardHtml = readFileSync(join(root, 'app', 'card.html'), 'utf8')
assert.match(cardHtml, /btn-pin/u, 'card needs a pin button')
const cardCss = readFileSync(join(root, 'app', 'card.css'), 'utf8')
assert.match(cardCss, /data-font/u, 'card must follow the font-size preference')
assert.match(cardCss, /data-motion/u, 'card must honor reduced motion')
assert.match(cardCss, /app-region/u, 'card header must be draggable')
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
assert.ok(changelog.split('\n').some((line) => line.startsWith(`## ${pkg.version}`)),
  `CHANGELOG.md must document v${pkg.version} (used for release notes)`)

const tokensCss = readFileSync(join(root, 'app', 'tokens.css'), 'utf8')
assert.match(tokensCss, /--primary: light-dark\(/u, 'shared primary controls need light and dark colors')
assert.match(tokensCss, /data-theme="dark"/u, 'shared tokens must support dark theme')
const appCss = readFileSync(join(root, 'app', 'app.css'), 'utf8')
const settingsCss = readFileSync(join(root, 'app', 'settings.css'), 'utf8')
assert.match(appCss, /\.sr-only/u, 'the live region must be visually hidden')
const resultTextSource = readFileSync(join(root, 'app', 'result-text.js'), 'utf8')
const uiTextSource = readFileSync(join(root, 'app', 'ui-text.js'), 'utf8')
assert.match(appCss, /@import '\.\/tokens\.css'/u, 'main window must use shared tokens')
assert.match(cardCss, /@import '\.\/tokens\.css'/u, 'card must use shared tokens')
assert.match(appCss, /\.notice\[hidden\]/u, 'hidden notice must stay hidden')
assert.match(htmlSource, /brand-mark/u, 'topbar needs the brand mark')
assert.match(appSource, /empty-examples/u, 'empty workspace must offer examples')
assert.match(appSource, /function setMode[\s\S]{0,600}retranslateCurrent/u,
  'switching mode must re-translate the current input so the result is not stale')
assert.match(htmlSource, /id="input"[^>]*placeholder="[^"]*paste/iu, 'composer must present paste as the main entry')
assert.match(appCss, /\.empty-examples\s*\{/u, 'empty state examples need layout styles')
assert.match(resultComponentSource, /guide-tools/u, 'guide actions need grouped controls')

assert.match(htmlSource, /id="btn-help"/u, 'help button must exist')
assert.match(htmlSource, /id="help-overlay"/u, 'shortcut help overlay must exist')
assert.match(htmlSource, /id="btn-scroll-bottom"/u, 'scroll-to-bottom FAB must exist')
assert.match(appSource, /showCopyDone/u, 'copy actions need inline feedback')
assert.match(appSource, /toggleHelp/u, 'help overlay needs a toggle handler')
assert.match(appSource, /updateScrollFab/u, 'stream needs scroll-position tracking')
assert.match(appSource, /is-collapsed/u, 'entries must support collapse')
assert.match(appSource, /is-warn/u, 'long input must warn via char count')
assert.match(appCss, /\.scroll-fab/u, 'FAB must be styled')
assert.match(appCss, /\.help-pop/u, 'help popover must be styled')
assert.match(cardSource, /is-done/u, 'card copy actions need inline feedback')

assert.match(htmlSource, /id="btn-history"/u, 'history sidebar needs a toggle button')
assert.match(htmlSource, /id="sidebar"/u, 'history sidebar must exist')
assert.match(htmlSource, /id="sidebar-backdrop"/u, 'history sidebar needs a click-away backdrop')
assert.match(htmlSource, /id="history-search"/u, 'history sidebar needs a search box')
assert.match(htmlSource, /id="history-list"/u, 'history sidebar needs a result list')
assert.match(htmlSource, /id="history-count"/u, 'history sidebar needs a match counter')
assert.match(htmlSource, /Toggle translation history/u, 'shortcut help must document the sidebar')
assert.match(appSource, /renderHistory/u, 'history list must be rendered')
assert.match(appSource, /jumpToEntry/u, 'history items must jump to their entry')
assert.match(appSource, /toggleSidebar/u, 'sidebar needs an open/close handler')
assert.match(appSource, /history-item/u, 'history rows must be built')
assert.match(appSource, /is-highlight/u, 'jumped-to entry must be highlighted')
assert.match(appCss, /\.sidebar/u, 'sidebar must be styled')
assert.match(appCss, /\.history-item/u, 'history rows must be styled')

assert.match(tokensCss, /data-accent="ocean"/u, 'tokens must define accent presets')
assert.match(tokensCss, /data-accent="rose"/u, 'accent presets must cover several hues')
assert.match(htmlSource, /id="opt-accent"/u, 'settings need an accent picker')
assert.match(htmlSource, /data-accent="emerald"/u, 'accent picker needs swatches')
assert.match(appSource, /root\.dataset\.accent/u, 'main window must apply the accent')
assert.match(cardSource, /root\.dataset\.accent/u, 'card must apply the accent')
assert.match(settingsCss, /\.accent-swatch/u, 'accent swatches must be styled')

assert.match(htmlSource, /id="btn-export"/u, 'topbar needs an export button')
assert.match(htmlSource, /id="export-menu"/u, 'export menu must exist')
assert.match(htmlSource, /id="export-note"/u, 'export menu needs a record counter')
assert.match(htmlSource, /data-export="json"/u, 'export menu must offer JSON download')
assert.match(appSource, /buildMarkdown/u, 'Markdown export must be built from the conversation')
assert.match(appSource, /buildJson/u, 'JSON export must be built from the conversation')
assert.match(appSource, /downloadText/u, 'exports must be downloaded via a blob')
assert.match(appSource, /toggleExportMenu/u, 'export menu needs an open/close handler')
assert.match(appSource, /activeEntryId/u, 'main window must track a single focused result')
assert.match(appSource, /state\.activeEntryId = entry\.id/u, 'a new lookup must focus its result')
assert.match(appSource, /state\.entries\.find\(\(item\) => item\.id === state\.activeEntryId\)/u,
  'render must show only the focused result')
assert.match(mainSource, /Menu\.setApplicationMenu\(null\)/u, 'Windows and Linux must suppress the default menu')
assert.match(mainSource, /role: 'editMenu'/u, 'macOS needs native editing shortcuts')
assert.match(windowsSource, /win\.removeMenu\(\)/u, 'Windows and Linux windows must remove the native menu')
assert.match(mainSource, /app\.getVersion\(\)/u, 'the installed version must come from Electron')
assert.match(preloadSource, /getAppVersion/u, 'preload must expose the installed version')
assert.match(htmlSource, /id="lang-target"/u, 'workspace language bar needs a target-language select')
assert.match(htmlSource, /for="lang-target"/u, 'language bar select needs an associated label')
assert.match(appSource, /function setTargetLanguage/u, 'target language must be set through one shared setter')
assert.match(appSource, /\['lang-target', 'opt-target-language'\]/u, 'both language selects must stay in sync')
assert.match(appCss, /\.lang-bar/u, 'language bar must be styled')
assert.match(appSource, /result-label/u, 'results need a labeled typography block')
assert.match(appSource, /source-label/u, 'source text stays available to copy and selection')
assert.match(appCss, /\.entry-source\s*\{[^}]*clip:[^}]*\}/u, 'duplicated source row must be visually hidden, not shown below the answer')
assert.match(appCss, /\.entry-card\s*\{[^}]*border-top:\s*1px solid var\(--border\)/u, 'results need a visual separator')
assert.match(appCss, /\.export-menu/u, 'export menu must be styled')
assert.match(appCss, /\.result-label/u, 'result label must be styled')
assert.match(appSource, /translation-answer/u, 'translate results need a prominent answer treatment')
assert.match(resultComponentSource, /pos-chip/u, 'dictionary senses need part-of-speech chips')
assert.match(resultComponentSource, /sense-example/u, 'dictionary senses need example lines')
assert.match(appCss, /\.translation-answer/u, 'answer treatment must be styled')
assert.match(appCss, /\.pos-chip/u, 'part-of-speech chips must be styled')
assert.match(appSource, /action-save/u, 'saving to the expression book must be a first-class result action')
assert.match(appSource, /data-saveButton|dataset\.saveButton/u, 'save action needs a stable selector')
assert.match(appCss, /\.actions button\.action-save/u, 'save action must be styled')
assert.match(appSource, /entry-card--guide/u, 'guide cards need a distinct learning style')
assert.doesNotMatch(appSource, /guide-intro/u, 'the vague guide-intro sentence must not be shown')
assert.match(resultComponentSource, /hint-step/u, 'guide hints need numbered step markers')
assert.match(appCss, /\.entry-card--guide/u, 'guide card style must be defined')
assert.match(appCss, /\.hint-step/u, 'hint step markers must be styled')

assert.match(htmlSource, /id="lang-source"/u, 'source language indicator needs a target element')
assert.match(appSource, /detectSourceLanguage/u, 'composer must detect the source language')
assert.match(appSource, /Detected: \$\{detectedLabel\}/u, 'detected language must be shown as a readable label')
assert.match(sharedSourceLanguage, /export function detectSourceLanguage/u, 'source detection must be a shared pure helper')
assert.match(htmlSource, /id="lang-source"[^>]*>/u, 'source language must be a selectable control')
assert.match(htmlSource, /id="btn-swap-lang"/u, 'workspace needs a one-click language swap button')
assert.match(appSource, /function setSourceLanguage/u, 'source language must be set through one shared setter')
assert.match(appSource, /function swapLanguages/u, 'language swap must be a dedicated action')
assert.match(appSource, /sourceLanguage: entry\.sourceLanguage/u, 'request payload must carry the source language')
assert.match(appSource, /desktop_source_language/u, 'source language must be persisted')
assert.match(sharedSourceLanguage, /export function planLanguageSwap/u, 'swap planning must be a shared pure helper')
assert.match(sharedSourceLanguage, /export function speechLanguageCode/u, 'TTS language mapping must be a shared pure helper')
assert.match(sharedSpeechSource, /speechLanguageCode\(text\)/u, 'speech must pick the voice language from the text')
assert.doesNotMatch(sharedSpeechSource, /\? 'zh-CN' : 'en-US'/u, 'speech must not hardcode a two-language TTS fallback')
assert.match(desktopTtsSource, /export function buildSpeechCommand/u,
  'desktop TTS command building must be a testable pure helper')
assert.match(desktopTtsSource, /VOICE_BY_LANG/u, 'desktop TTS must map languages to voices')
assert.match(desktopTtsSource, /lang: options\.lang/u, 'desktop TTS must forward the computed language')
assert.match(desktopTtsSource, /'ja-JP'/u, 'desktop TTS must cover non-Chinese/English languages')
assert.match(sharedContractsSource, /export function resolveSourceLanguage/u, 'source language must be resolved in the contract')
assert.match(sharedContractsSource, /source_lang: resolvedSource/u, 'Qwen-MT request must honor the source language')

assert.match(appSource, /function startCompanionEntry/u, 'translate and guide modes must connect via a one-click companion entry')
assert.match(appSource, /dataset\.companionMode/u, 'companion action must target the opposite mode')
assert.match(appSource, /menuAdd\([\s\S]{0,240}'action-companion'/u,
  'companion action must be tucked into the more menu to keep the result toolbar compact')
assert.match(resultComponentSource, /lexical-details/u, 'dictionary details must be progressively disclosed')
assert.match(appCss, /\.lexical-details\s*>\s*summary/u, 'dictionary disclosure summary must be styled')

assert.match(htmlSource, /id="opt-target-language"/u, 'target language selector is required')
assert.match(appSource, /desktop_target_language/u, 'target language must be persisted')
assert.match(appSource, /targetLanguage: entry\.targetLanguage/u, 'target language must be sent with translation requests')
assert.match(sharedBackgroundSource, /const targetLanguage = payload\?\.targetLanguage/u,
  'background must forward target language into request builders')
assert.match(sharedContractsSource, /getTargetLanguage\(text, targetLanguage\)/u,
  'request builders must accept a target language override')
assert.match(sharedContractsSource, /buildTranslationSystemPrompt/u,
  'generic system prompt must honor an explicit target language')

assert.match(htmlSource, /id="btn-archive-export"/u, 'full archive export button is required')
assert.match(htmlSource, /id="btn-archive-import"/u, 'full archive import button is required')
assert.match(htmlSource, /id="archive-file"/u, 'archive file picker is required')
assert.match(appSource, /buildLearningArchive/u, 'app must build portable archives')
assert.match(appSource, /parseLearningArchive/u, 'app must parse imported archives')
assert.match(appSource, /planArchiveImport/u, 'import must plan conflicts before applying')
assert.match(appSource, /pendingArchiveImport/u, 'conflicting imports must wait for user confirmation')
assert.match(appSource, /archive-conflict-keep/u, 'conflict confirmation must be wired')
assert.match(appSource, /archive-conflict-cancel/u, 'users must be able to cancel a conflicting import')
assert.match(appSource, /translation_memory: memory/u, 'import must restore translation memory')
assert.match(htmlSource, /id="archive-conflict"/u, 'archive conflict prompt is required')
assert.match(settingsCss, /\.archive-conflict/u, 'archive conflict prompt must be styled')
assert.match(sharedArchiveSource, /export function buildLearningArchive/u, 'shared module must build archives')
assert.match(sharedArchiveSource, /export function parseLearningArchive/u, 'shared module must validate archives')
assert.match(sharedArchiveSource, /export function migrateArchive/u, 'archives must support version migration')
assert.match(sharedArchiveSource, /export function planArchiveImport/u, 'shared module must plan conflict-safe imports')

assert.match(sharedMemorySource, /export function makeMemoryKey/u, 'translation memory must have a stable key helper')
assert.match(sharedMemorySource, /export function memoryTextKey/u,
  'translation memory must keep selected-text case significant in its key')
assert.match(sharedMemorySource, /memoryTextKey\(text\)/u,
  'translation memory key must use the case-preserving text normalizer')
assert.match(sharedMemorySource, /sourceLanguage = 'auto'/u,
  'translation memory key must account for pinned source language')
assert.match(appSource, /targetLanguage, sourceLanguage, model: state\.model/u,
  'main window must include source language in the memory key')
assert.match(sharedBackgroundSource, /sourceLanguage: payload\?\.sourceLanguage/u,
  'extension must include source language in the memory key')
assert.match(sharedMemorySource, /export function readMemoryEntry/u, 'translation memory must support cache lookups')
assert.match(sharedMemorySource, /export function writeMemoryEntry/u, 'translation memory must support cache writes')
assert.match(appSource, /readMemoryEntry\(state\.translationMemory/u, 'main window must consult translation memory on submit')
assert.match(appSource, /writeMemoryEntry\(state\.translationMemory/u, 'main window must fill translation memory on success')
assert.match(appSource, /translation_memory/u, 'translation memory must be persisted across sessions')
assert.match(appSource, /memory-tag/u, 'memory hits must be labeled on the study card')
assert.match(appSource, /The model returned no translation/u,
  'empty translation results must surface as a clear retryable error')
assert.match(appSource, /entry\.memoryKey && \(entry\.mode === 'guide' \? entry\.guide : entry\.translatedText\)/u,
  'empty results must never be written into translation memory')

const sharedContentSource = readFileSync(new URL('../../src/content.js', import.meta.url), 'utf8')
assert.match(sharedBackgroundSource, /loadTranslationMemory/u,
  'extension background must load the shared translation memory')
assert.match(sharedBackgroundSource, /rememberTranslation/u,
  'extension background must persist fresh translations to memory')
assert.match(sharedBackgroundSource, /fromMemory: true/u,
  'extension background must label memory hits for the content script')
assert.match(sharedBackgroundSource, /IS_EXTENSION_SERVICE_WORKER/u,
  'translation memory must stay scoped to the real extension service worker')
assert.match(sharedBackgroundSource, /isRateLimited/u,
  'background must detect rate-limit responses')
assert.match(sharedBackgroundSource, /planRetry/u,
  'background must compute bounded retry delays for 429 responses')
assert.match(sharedBackgroundSource, /sleepAbortable/u,
  'background retries must be abortable so cancellation stays responsive')
assert.match(sharedBackgroundSource, /const isDesktopWordTranslation = !IS_EXTENSION_SERVICE_WORKER && kind === 'translate' && isSingleWordInput\(text\)/u,
  'lexical enrichment must be desktop-only so the Chrome extension keeps its qwen-mt streaming behavior')
assert.match(sharedBackgroundSource, /getLearningModel\('', reading\.learningModel\)/u,
  'single words must be enriched via the configured learning model when available')
assert.match(sharedContentSource, /stt-memory-badge/u,
  'extension card must surface a translation-memory badge')
assert.match(sharedContentSource, /state\.activeSelection\.fromMemory/u,
  'extension card must track memory hits per selection')

assert.match(sharedGlossarySource, /export function buildGlossaryInstruction/u,
  'glossary rules must be built by a reusable module')
assert.match(sharedGlossarySource, /export function sanitizeGlossary/u,
  'glossary entries must be sanitized before use')
assert.match(sharedContractsSource, /buildGlossaryInstruction/u,
  'request builders must honor the terminology glossary')
assert.match(sharedBackgroundSource, /glossary: payload\?\.glossary/u,
  'background must forward the glossary into request builders')
assert.match(appSource, /glossary: \[\]/u, 'main window must hold glossary state')
assert.match(appSource, /desktop_glossary/u, 'glossary must be persisted')
assert.match(appSource, /function renderGlossaryList/u, 'glossary list must be rendered')
assert.match(htmlSource, /id="glossary-add"/u, 'settings need a glossary add control')

assert.match(sharedAnkiSource, /export function buildAnkiTsv/u, 'Anki TSV builder must be a reusable module')
assert.match(sharedAnkiSource, /escapeAnkiField/u, 'Anki export must escape untrusted field content')
assert.match(sharedLibraryHtmlForAnki, /id="export-anki"/u, 'vocabulary book needs an Anki export button')
assert.match(sharedLibrarySourceForAnki, /downloadAnki/u, 'vocabulary book must wire the Anki export action')
assert.match(sharedLibrarySourceForAnki, /buildAnkiTsv/u, 'Anki export must use the shared TSV builder')

assert.match(sharedProgressSource, /getStudyProgress/u, 'shared learning progress must be computed')
assert.match(sharedProgressSource, /MASTERY_INTERVAL_DAYS/u, 'mastery threshold must be explicit')
assert.match(htmlSource, /id="btn-study-progress"/u, 'main window needs a study progress reminder')
assert.match(htmlSource, /id="study-progress-text"/u, 'study progress reminder needs a live label')
assert.match(appSource, /updateStudyProgress/u, 'main window must refresh study progress')
assert.match(appSource, /getStudyProgress/u, 'main window must use the shared progress helper')
assert.match(appCss, /\.study-progress-chip/u, 'study progress reminder must be styled')
assert.match(sharedLibraryHtml, /id="study-progress"/u, 'vocabulary book needs a progress panel')
assert.match(sharedLibraryHtml, /id="today-review-reminder"/u, 'vocabulary book needs a today-review reminder')
assert.match(sharedLibraryHtml, /id="start-review"/u, 'reminder must offer a review shortcut')
assert.match(sharedLibrarySource, /getStudyProgress/u, 'vocabulary book must render study progress')
assert.match(sharedLibraryCss, /\.study-progress/u, 'vocabulary book progress must be styled')

assert.match(sharedProgressSource, /buildReviewReminder/u, 'shared helper must build the review reminder')
assert.match(sharedProgressSource, /getDayKey/u, 'shared helper must compute a stable local day key')
assert.match(sharedProgressSource, /shouldShowReviewReminder/u, 'shared helper must dedup the reminder per day')
assert.match(appSource, /maybeShowReviewReminder/u, 'main window must proactively show the review reminder')
assert.match(appSource, /buildReviewReminder/u, 'main window must use the shared reminder builder')
assert.match(appSource, /lastReviewReminderDate/u, 'reminder date must be persisted in local storage')
assert.match(appSource, /shouldShowReviewReminder\(saved\?\.lastReviewReminderDate\)/u,
  'reminder must respect the persisted day key')
assert.match(appSource, /getDayKey\(\)/u, 'reminder must persist the current day key')
assert.match(appSource, /'review'/u, 'review reminder must use the review notice kind')
assert.match(appCss, /\.notice\[data-kind="review"\]/u, 'review reminder must be styled distinctly')
assert.match(appCss, /\.notice-close/u, 'review reminder must offer a dismiss control')

const liveLanguagesScript = readFileSync(
  fileURLToPath(new URL('./verify-live-languages.mjs', import.meta.url)), 'utf8')
const liveLanguagesZhScript = readFileSync(
  fileURLToPath(new URL('./verify-live-languages-zh.mjs', import.meta.url)), 'utf8')
const languageDetectSource = readFileSync(
  fileURLToPath(new URL('./e2e/language-detect.mjs', import.meta.url)), 'utf8')
assert.match(languageDetectSource, /export function detectLanguage/u,
  'language detector must be a reusable pure helper')
assert.match(liveLanguagesScript, /requestCapPerLanguage: 1/u,
  'live language verification must cap requests per language')
assert.match(liveLanguagesScript, /detectLanguage/u,
  'live language verification must assert the actual output language')
assert.match(liveLanguagesScript, /STT_LIVE_SOURCE_TEXT/u,
  'live language verification must accept a configurable source text')
assert.match(liveLanguagesZhScript, /STT_LIVE_SOURCE_LANG\s*=\s*'zh'/u,
  'Chinese-source live verification must be available')
assert.match(liveLanguagesScript, /STT_LIVE_CONFIG/u,
  'live language verification must be credential-gated')

assert.match(appSource, /function patchStreamResult/u, 'stream chunks must patch the result in place')
assert.match(appSource, /if \(payload\.status === 'stream'\) \{/u, 'stream events must take the in-place path')
assert.match(appSource, /languageText\('span', 'translation-text', entry\.translatedText/u,
  'stream text must use the language-tagged text renderer')
assert.match(appSource, /node\.textContent = text/u, 'the text renderer must treat model output as plain text')
assert.match(appSource, /function patchStreamResult[\s\S]{0,600}translation-answer/u,
  'streaming must render into the same answer block as completed results so styling does not jump')
assert.match(appCss, /\.translation-answer\s*\{[^}]*var\(--font-reading\)/u,
  'the primary translation must use the shared reading font')

assert.match(tokensCss, /--accent:/u, 'shared tokens must define the accent color')
assert.match(tokensCss, /--surface:/u, 'shared tokens must define the surface ramp')
assert.match(tokensCss, /--border:/u, 'shared tokens must define borders')
assert.match(tokensCss, /light-dark\(/u, 'color roles must adapt via light-dark()')
assert.match(tokensCss, /forced-colors: active/u, 'color roles need forced-colors fallbacks')
assert.match(tokensCss, /::selection/u, 'selection must use a shared token color')
assert.match(htmlSource, /name="color-scheme"/u, 'color-scheme meta prevents an unthemed flash')

assert.match(tokensCss, /--fs-base:/u, 'base font size token must be defined')
assert.match(tokensCss, /--shadow-1:/u, 'elevation scale must be defined')
assert.match(tokensCss, /--r-lg:/u, 'shape scale must be defined')
assert.match(appCss, /--shadow-1/u, 'containers must use the shared elevation scale')
assert.match(appCss, /--shadow-2/u, 'cards must use the shared elevation scale')
assert.match(tokensCss, /--shadow-card:/u, 'floating card shadow token must be defined')
assert.match(cardCss, /--shadow-card/u, 'floating card must use the clipped-safe shadow token')
assert.match(windowsSource, /hasShadow:\s*false/u, 'transparent card window must disable the native shadow on macOS')

assert.match(tokensCss, /--on-primary:/u, 'button ink token must be defined')
assert.match(appCss, /button\.primary\s*\{[^}]*var\(--primary\)/u, 'primary buttons must use the shared primary color')
assert.match(appCss, /--accent-soft/u, 'state layers must use the shared accent wash')
assert.match(appCss, /border-radius: var\(--r-sm\)/u, 'buttons must use the shared shape scale')
assert.match(cardCss, /border-radius: var\(--r-lg\)/u, 'card buttons must share the shape scale')

assert.match(tokensCss, /--border-strong:/u, 'outlined field token must be defined')
assert.match(tokensCss, /--surface-2:/u, 'container surface token must be defined')
assert.match(tokensCss, /--r-pill:/u, 'chip shape token must be defined')
assert.match(appCss, /--border-strong/u, 'fields must use the shared outline')
assert.match(appCss, /var\(--accent-soft\)/u, 'selected chips must use the accent wash')

assert.match(tokensCss, /--ease:/u, 'standard easing must be defined')
assert.match(tokensCss, /--t:/u, 'duration scale must be defined')
assert.match(tokensCss, /--t: 160ms/u, 'legacy --t must map to the duration token')
assert.match(appCss, /var\(--ease\)/u, 'dialogs must use the shared easing')
assert.match(appCss, /transition: background var\(--t\)/u, 'surfaces need a shared motion transition')
assert.match(cardCss, /var\(--t\)/u, 'floating card must share the easing')

assert.match(cardCss, /--danger/u, 'card errors must use the shared danger color')
assert.match(cardCss, /var\(--surface\)/u, 'card actions must use the shared surface')

assert.match(cardSource, /function patchStreamResult/u, 'floating card must patch streaming text in place')
assert.match(cardSource, /patchStreamResult\(entry\)/u, 'stream events must use the in-place patch')
assert.match(cardSource, /createTextNode\(entry\.translatedText/u, 'stream patch must keep text in place without rebuilding actions')
assert.match(cardSource, /resultEl\.className = 'result'/u, 'stream patch must clear stale loading state')

assert.match(appSource, /function patchSpeechButtons/u, 'speech changes must patch buttons without a full render')
assert.match(appSource, /data-speech-button/u, 'speech buttons must be individually addressable')
assert.match(appSource, /aria-pressed/u, 'speech buttons must expose pressed state')
assert.match(appSource, /state\.speechEntryId/u, 'active speech must be scoped to its entry')
assert.match(appSource, /STOP_SPEECH/u, 'new submissions must stop stale speech')

assert.match(appSource, /function revealNextHint/u, 'progressive hints must reveal in place')
assert.match(appSource, /data-hint-more/u, 'progressive hints need an in-place reveal control')
assert.match(resultComponentSource, /\.dataset\.hints\s*=/u, 'hints container must be patchable in place')
assert.doesNotMatch(appSource, /hint is-hidden/u, 'no fake hidden placeholder rows may be rendered')
assert.match(appCss, /@keyframes hint-in/u, 'newly revealed hints must animate in')
assert.match(appCss, /data-hint-more/u, 'reveal control gets a lighter M3 treatment')

assert.match(appSource, /draft: null/u, 'composer draft state must exist')
assert.match(appSource, /function stashDraft/u, 'draft stashing helper must exist')
assert.match(appSource, /function restoreDraft/u, 'draft restore helper must exist')
assert.match(appSource, /function showDraftNotice/u, 'draft notice helper must exist')
assert.match(appSource, /Restore draft/u, 'restore action must be offered')
assert.match(appCss, /data-kind="draft"/u, 'draft notice must be visually distinct')
assert.match(tokensCss, /--border:/u, 'dialog border token must be defined')
assert.match(tokensCss, /--r-lg:/u, 'dialog shape token must be defined')
assert.match(htmlSource, /id="settings-backdrop"/u, 'settings dialog needs a scrim backdrop')
assert.match(htmlSource, /id="settings-panel" role="dialog"[^>]*aria-labelledby="settings-title"/u,
  'settings panel must be a dialog labelled by its heading')
assert.match(appSource, /function trapFocus/u, 'dialogs must trap keyboard focus')
assert.match(appSource, /function closeTransientPanels/u, 'panels must be mutually exclusive')
assert.match(appCss, /\[role="dialog"\] :focus-visible/u, 'dialog focus must be clearly visible')

assert.match(resultTextSource, /export function resultPlainText/u, 'shared result text helper must be exported')
assert.match(resultTextSource, /Pronunciation/u, 'shared helper must include phonetic details')
assert.match(resultTextSource, /Context/u, 'shared helper must include contextual analysis')
assert.match(resultTextSource, /answerRevealed/u, 'shared helper must respect revealed answers')
assert.match(appSource, /from '\.\/result-text\.js'/u, 'main window must import the shared helper')
assert.match(cardSource, /resultPlainText/u, 'floating card must use the shared result text')

assert.match(tokensCss, /--font-reading:/u, 'reading font stack must be defined')
assert.match(tokensCss, /--measure:/u, 'reading measure must be defined')
assert.match(tokensCss, /--lh-result:/u, 'reading line height must be defined')
assert.match(appCss, /max-width: var\(--measure\)/u, 'result must use a reading measure')
assert.match(appCss, /text-wrap: pretty/u, 'result should avoid orphan lines')
assert.match(appCss, /\.entry-body \.result::selection/u, 'reading text selection must use the accent wash')

assert.match(appSource, /function restoreFailedText/u, 'failed text must be restorable')
assert.match(appSource, /restoreFailedText\(entry\)/u, 'error path must restore the submitted text')
assert.match(appSource, /function cancelRequest[\s\S]{0,400}restoreFailedText\(entry\)/u,
  'cancel path must restore the submitted text so it is not stranded')
assert.match(appSource, /function cancelRequest[\s\S]{0,200}entry\.requestId = makeId\('r'\)/u,
  'cancel must rotate requestId so a late stream/success event cannot resurrect the cancelled translation')
assert.match(cardSource, /function cancelRequest[\s\S]{0,200}entry\.requestId = makeId\('r'\)/u,
  'floating card cancel must rotate requestId so a late event cannot resurrect the cancelled translation')
assert.match(appSource, /error-message/u, 'errors need a structured message')
assert.match(appSource, /setAttribute\('role', 'alert'\)/u, 'errors must be announced to screen readers')
assert.match(appCss, /--danger-soft/u, 'errors must use the danger wash')
assert.match(appCss, /\.error-tools/u, 'error actions need an M3 layout')

assert.match(htmlSource, /id="snackbar"/u, 'undo snackbar must exist')
assert.match(htmlSource, /id="snackbar-action"/u, 'snackbar needs an action button')
assert.match(appSource, /function showSnackbar/u, 'snackbar helper must exist')
assert.match(appSource, /Clear translation history \(/u, 'clear must ask for confirmation')
assert.match(appSource, /Entry restored/u, 'delete must be undoable')
assert.match(appCss, /\.snackbar/u, 'snackbar must use the M3 surface')

assert.match(htmlSource, /id="btn-toggle-key"/u, 'settings need a key visibility toggle')
assert.match(htmlSource, /id="cfg-base-url-error"/u, 'settings need inline field errors')
assert.match(appSource, /function updateSettingsValidity/u, 'settings validity must be computed')
assert.match(appSource, /function isValidBaseUrl/u, 'the API URL must be validated')
assert.match(appSource, /aria-invalid/u, 'invalid fields need aria-invalid')
assert.match(settingsCss, /\.field-error/u, 'field errors must be styled')
assert.match(settingsCss, /\.field-toggle/u, 'the key toggle must be styled')

assert.match(htmlSource, /aria-keyshortcuts/u, 'shortcut buttons must advertise aria-keyshortcuts')
assert.match(htmlSource, /aria-label="Open log file"/u, 'icon-only buttons must have accessible names')
assert.match(htmlSource, /aria-label="Jump to latest result"/u, 'the scroll FAB must have an accessible name')
assert.match(cardHtml, /aria-label="Open in main window"/u, 'card controls must have accessible names')
assert.match(appCss, /outline: 2px solid var\(--accent\)/u, 'focus ring must be a crisp accent outline')
assert.match(appCss, /forced-colors: active/u, 'focus ring must survive forced-colors mode')
assert.match(cardCss, /forced-colors: active/u, 'card focus ring must survive forced-colors mode')

assert.match(uiTextSource, /export const ACTION_LABELS = Object\.freeze/u, 'shared action labels must be a frozen object')
assert.match(uiTextSource, /export function showCopyDone/u, 'copy feedback must be shared from one module')
assert.match(uiTextSource, /stopSpeak:/u, 'speech labels must be centralized')
assert.match(appSource, /from '\.\/ui-text\.js'/u, 'main window must use the shared action labels')
assert.match(cardSource, /from '\.\/ui-text\.js'/u, 'floating card must use the shared action labels')
assert.match(cardSource, /ACTION_LABELS\.stopSpeak/u, 'card speech wording must match the main window')
assert.match(cardSource, /ACTION_LABELS\.cancel/u, 'card cancel wording must match the main window')

assert.match(htmlSource, /id="statusbar" role="status" aria-live="polite"/u, 'status bar must be a polite live region')
assert.match(htmlSource, /aria-atomic="true"/u, 'status bar must announce atomically')
assert.match(htmlSource, /<svg aria-hidden="true"/u, 'main window decorative svgs must be hidden from AT')
assert.match(cardHtml, /<svg aria-hidden="true"/u, 'card decorative svgs must be hidden from AT')
assert.match(appSource, /<svg aria-hidden="true"/u, 'dynamically rendered svgs must be hidden from AT')
assert.match(cardHtml, /role="status"/u, 'card result must remain a live region')

console.log(`[verify] ok  v${pkg.version}  ${files.length} source files`)
