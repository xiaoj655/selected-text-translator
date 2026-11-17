import assert from 'node:assert/strict'
import test from 'node:test'
import { detectSourceLanguage, sourceLanguageLabel } from '../src/source-language.js'

test('detectSourceLanguage recognizes scripts', () => {
  assert.equal(detectSourceLanguage('おはようございます、友達'), 'japanese')
  assert.equal(detectSourceLanguage('좋은 아침이에요, 내 친구'), 'korean')
  assert.equal(detectSourceLanguage('你好,我的朋友'), 'chinese')
})

test('detectSourceLanguage scores Latin markers', () => {
  assert.equal(detectSourceLanguage('Bonjour mon ami, comment allez-vous aujourd\'hui?'), 'french')
  assert.equal(detectSourceLanguage('Guten Morgen mein Freund, wie geht es dir heute?'), 'german')
  assert.equal(detectSourceLanguage('Buenos días amigo, ¿cómo estás hoy?'), 'spanish')
})

test('detectSourceLanguage falls back to English for plain Latin', () => {
  assert.equal(detectSourceLanguage('record'), 'english')
  assert.equal(detectSourceLanguage('The band will record a new record tomorrow.'), 'english')
})

test('detectSourceLanguage returns empty for empty or non-text input', () => {
  assert.equal(detectSourceLanguage(''), '')
  assert.equal(detectSourceLanguage(null), '')
  assert.equal(detectSourceLanguage('12345 !!!'), '')
})

test('sourceLanguageLabel maps codes to Chinese labels', () => {
  assert.equal(sourceLanguageLabel('english'), '英语')
  assert.equal(sourceLanguageLabel('chinese'), '中文')
  assert.equal(sourceLanguageLabel('japanese'), '日语')
  assert.equal(sourceLanguageLabel('unknown'), '')
})
