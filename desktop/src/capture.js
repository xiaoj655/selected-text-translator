import { execFile } from 'node:child_process'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function runCommand(command, args, timeout = 1500) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, windowsHide: true }, (error) => resolve(!error))
  })
}

function copyCommand(platform) {
  if (platform === 'darwin') {
    return ['osascript', ['-e', 'tell application "System Events" to keystroke "c" using {command down}']]
  }
  if (platform === 'win32') {
    return ['powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^c')",
    ]]
  }
  return ['xdotool', ['key', '--clearmodifiers', 'ctrl+c']]
}

export function createCapture({ clipboard, platform = process.platform, delay = wait, run = runCommand, logger = () => {} }) {
  let mode = 'auto'

  function setMode(next) {
    mode = next === 'clipboard' ? 'clipboard' : 'auto'
  }

  async function simulateCopy() {
    const [command, args] = copyCommand(platform)
    try {
      return await run(command, args)
    } catch (error) {
      logger('copy simulation failed', error)
      return false
    }
  }

  async function readClipboardText() {
    try {
      return String(await clipboard.readText() || '')
    } catch {
      // clipboard may be locked by another app
      return ''
    }
  }

  async function writeClipboardText(value) {
    try {
      await clipboard.writeText(String(value || ''))
    } catch {
      // restoring is best effort
    }
  }

  async function capture() {
    const before = await readClipboardText()

    const didCopy = mode === 'clipboard' ? false : await simulateCopy()
    let after = before
    if (didCopy) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await delay(40)
        const current = await readClipboardText()
        if (current && current !== before) {
          after = current
          break
        }
      }
      if (after !== before) {
        await writeClipboardText(before)
      }
    }

    return {
      text: after.trim().slice(0, 12000),
      context: '',
      contextStart: null,
      contextEnd: null,
      source: didCopy && after !== before ? 'simulated-copy'
        : mode === 'clipboard' ? 'clipboard-only' : 'clipboard',
    }
  }

  return { capture, setMode, getMode: () => mode }
}
