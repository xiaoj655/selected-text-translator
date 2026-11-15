import { readFileSync, writeFileSync } from 'node:fs'

const pkgUrl = new URL('../package.json', import.meta.url)
const lockUrl = new URL('../package-lock.json', import.meta.url)
const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8'))
const [major, minor, patch] = pkg.version.split('.').map(Number)
pkg.version = `${major}.${minor}.${patch + 1}`
writeFileSync(pkgUrl, `${JSON.stringify(pkg, null, 2)}\n`)

try {
  const lock = JSON.parse(readFileSync(lockUrl, 'utf8'))
  lock.version = pkg.version
  if (lock.packages?.['']) lock.packages[''].version = pkg.version
  writeFileSync(lockUrl, `${JSON.stringify(lock, null, 2)}\n`)
} catch {
  // lock file is optional for local iteration
}

console.log(pkg.version)
