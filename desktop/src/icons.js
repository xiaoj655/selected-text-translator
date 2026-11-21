import { join } from 'node:path'
import { nativeImage } from 'electron'

export function loadDesktopIcons(assetsDir) {
  // Keep ICO for the Windows executable/installer. Runtime images use PNG so
  // windows and the tray share Electron's image decoder on every platform.
  const appIcon = nativeImage.createFromPath(join(assetsDir, 'icon.png'))
  if (appIcon.isEmpty()) throw new Error('Cannot load the application PNG icon')

  const trayIcon = process.platform === 'darwin'
    ? nativeImage.createFromPath(join(assetsDir, 'trayTemplate.png'))
    : appIcon.resize({ width: 32, height: 32 })
  if (trayIcon.isEmpty()) throw new Error('Cannot load the tray icon')

  return { appIcon, trayIcon }
}
