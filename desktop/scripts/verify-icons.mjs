import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPackage } from '@electron/asar'
import electronBinary from 'electron'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const desktopDir = resolve(scriptsDir, '..')
const artifactsDir = join(desktopDir, 'artifacts', 'icons')
const temporaryDir = mkdtempSync(join(tmpdir(), 'stt-verify-icons-'))

try {
  const fixtureDir = join(temporaryDir, 'fixture')
  const archivePath = join(temporaryDir, 'icons.asar')
  const userDataDir = join(temporaryDir, 'user-data')
  mkdirSync(join(fixtureDir, 'src'), { recursive: true })
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(artifactsDir, { recursive: true })
  cpSync(join(desktopDir, 'assets'), join(fixtureDir, 'assets'), { recursive: true })
  copyFileSync(join(desktopDir, 'src', 'icons.js'), join(fixtureDir, 'src', 'icons.js'))
  copyFileSync(join(scriptsDir, 'verify-icons-fixture.cjs'), join(fixtureDir, 'verify-icons.cjs'))
  writeFileSync(join(fixtureDir, 'package.json'), JSON.stringify({
    name: 'stt-icon-verification',
    version: '1.0.0',
    type: 'module',
    main: 'verify-icons.cjs',
  }))
  await createPackage(fixtureDir, archivePath)

  const env = {
    ...process.env,
    STT_ICON_SOURCE_DIR: desktopDir,
    STT_ICON_ARTIFACTS_DIR: artifactsDir,
    STT_ICON_USER_DATA_DIR: userDataDir,
  }
  delete env.ELECTRON_RUN_AS_NODE
  const electronArgs = [archivePath]
  if (process.platform === 'linux' && process.getuid?.() === 0) electronArgs.unshift('--no-sandbox')
  const headless = process.platform === 'linux' && !process.env.DISPLAY
  const command = headless ? 'dbus-run-session' : electronBinary
  const args = headless
    ? ['--', 'xvfb-run', '-a', '-s', '-screen 0 1280x800x24', electronBinary, ...electronArgs]
    : electronArgs
  const result = spawnSync(command, args, {
    env,
    stdio: 'inherit',
    timeout: 45000,
    windowsHide: true,
  })
  if (result.error) throw result.error
  assert.equal(result.signal, null, `Electron icon verification was terminated by ${result.signal}`)
  assert.equal(result.status, 0, `Electron icon verification exited with status ${result.status}`)
  console.log('[icons] ok - source and ASAR window/tray images match and contain visible pixels')
  console.log(`[icons] PNG previews: ${artifactsDir}`)
} finally {
  rmSync(temporaryDir, { recursive: true, force: true })
}
