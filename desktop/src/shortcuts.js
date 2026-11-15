export const HOTKEY_OPTIONS = [
  'Alt+Shift+E',
  'Alt+Shift+D',
  'CommandOrControl+Alt+E',
  'CommandOrControl+Shift+E',
]

export function createShortcuts({ globalShortcut, storage, onTrigger, logger = () => {} }) {
  let current = null

  async function register(accelerator) {
    const next = typeof accelerator === 'string' && accelerator.trim()
      ? accelerator.trim()
      : HOTKEY_OPTIONS[0]
    if (current) globalShortcut.unregister(current)
    let registered = false
    try {
      registered = globalShortcut.register(next, onTrigger)
    } catch {
      registered = false
    }
    if (!registered) {
      logger(`hotkey unavailable: ${next}`)
      if (current) {
        globalShortcut.register(current, onTrigger)
        return current
      }
      return null
    }
    current = next
    await storage.sync.set({ desktop_hotkey: next })
    return next
  }

  async function init() {
    const saved = await storage.sync.get(['desktop_hotkey'])
    return register(saved?.desktop_hotkey || HOTKEY_OPTIONS[0])
  }

  return {
    init,
    register,
    current: () => current,
  }
}
