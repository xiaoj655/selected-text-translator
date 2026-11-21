import { cpSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auxiliaryHtmlPages, localizeAuxiliaryHtml } from './auxiliary-html-en.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const desktopDir = join(here, '..')
const repoRoot = join(desktopDir, '..')
const vendorDir = join(desktopDir, 'vendor')
const srcTarget = join(vendorDir, 'src')

if (!existsSync(join(repoRoot, 'src', 'content.js'))) {
  throw new Error('Cannot find shared src/ directory. Run this from the repository checkout.')
}

rmSync(vendorDir, { recursive: true, force: true })
mkdirSync(srcTarget, { recursive: true })
cpSync(join(repoRoot, 'src'), srcTarget, { recursive: true })
for (const name of auxiliaryHtmlPages) {
  const path = join(srcTarget, name)
  writeFileSync(path, localizeAuxiliaryHtml(name, readFileSync(path, 'utf8')))
}

console.log(`[sync] shared sources copied to ${srcTarget}`)
