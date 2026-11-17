import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSpeechCommand } from '../desktop/src/tts.js'

test('spd-say gets a language flag on Linux', () => {
  const fr = buildSpeechCommand({ platform: 'linux', text: 'Bonjour', lang: 'fr-FR' })
  assert.equal(fr.command, 'spd-say')
  assert.deepEqual(fr.args.slice(0, 2), ['-l', 'fr'])
  assert.equal(fr.args.at(-1), 'Bonjour')

  const ja = buildSpeechCommand({ platform: 'linux', text: 'こんにちは', lang: 'ja-JP' })
  assert.deepEqual(ja.args.slice(0, 2), ['-l', 'ja'])
})

test('spd-say omits the language flag when unknown', () => {
  const none = buildSpeechCommand({ platform: 'linux', text: 'hello', lang: '' })
  assert.deepEqual(none.args, ['hello'])
})

test('macOS say picks a language-appropriate voice', () => {
  const ja = buildSpeechCommand({ platform: 'darwin', text: 'こんにちは', lang: 'ja-JP' })
  assert.equal(ja.command, 'say')
  assert.deepEqual(ja.args.slice(-4, -1), ['-v', 'Kyoko', '--'])
  assert.equal(ja.args.at(-1), 'こんにちは')

  const fr = buildSpeechCommand({ platform: 'darwin', text: 'Bonjour', lang: 'fr-FR' })
  assert.ok(fr.args.includes('Thomas'))
})

test('macOS honours an explicit voice over the language default', () => {
  const cmd = buildSpeechCommand({ platform: 'darwin', text: 'hi', lang: 'fr-FR', voiceName: 'Samantha' })
  assert.deepEqual(cmd.args.slice(-4, -1), ['-v', 'Samantha', '--'])
})

test('Windows selects culture and voice for the language', () => {
  const de = buildSpeechCommand({ platform: 'win32', text: 'Guten Tag', lang: 'de-DE' })
  assert.equal(de.command, 'powershell.exe')
  const script = de.args.at(-1)
  assert.match(script, /CultureInfo\('de-DE'\)/u)
  assert.match(script, /SelectVoice\('Microsoft Stefan Desktop'\)/u)
  assert.match(script, /Guten Tag/u)
})

test('rate is clamped and script text is escaped on Windows', () => {
  const cmd = buildSpeechCommand({ platform: 'win32', text: "l'ami", rate: 99, lang: 'fr-FR' })
  const script = cmd.args.at(-1)
  assert.match(script, /l''ami/u)
  assert.match(script, /\$s\.Rate = 5/u)
})
