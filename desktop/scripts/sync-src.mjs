import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const desktopDir = join(here, '..')
const repoRoot = join(desktopDir, '..')
const vendorDir = join(desktopDir, 'vendor')
const srcTarget = join(vendorDir, 'src')
const iconSource = join(repoRoot, 'assets', 'icon128.png')

if (!existsSync(join(repoRoot, 'src', 'content.js'))) {
  throw new Error('Cannot find shared src/ directory. Run this from the repository checkout.')
}

rmSync(vendorDir, { recursive: true, force: true })
mkdirSync(srcTarget, { recursive: true })
cpSync(join(repoRoot, 'src'), srcTarget, { recursive: true })

if (existsSync(iconSource)) {
  mkdirSync(join(vendorDir, 'assets'), { recursive: true })
  cpSync(iconSource, join(vendorDir, 'assets', 'icon128.png'))
}

console.log(`[sync] shared sources copied to ${srcTarget}`)
