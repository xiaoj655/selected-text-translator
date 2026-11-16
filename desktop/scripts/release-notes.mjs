import { readFileSync } from 'node:fs'

const version = String(process.argv[2] || '').replace(/^desktop-v/, '').replace(/^v/, '')
if (!version) {
  console.error('usage: node scripts/release-notes.mjs <version>')
  process.exit(1)
}

const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
const lines = changelog.split('\n')
const start = lines.findIndex((line) => line.startsWith(`## ${version}`))
if (start === -1) {
  console.error(`desktop/CHANGELOG.md has no section for ${version}`)
  process.exit(1)
}
const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
const body = lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim()
if (!body) {
  console.error(`desktop/CHANGELOG.md section for ${version} is empty`)
  process.exit(1)
}
console.log(body)
