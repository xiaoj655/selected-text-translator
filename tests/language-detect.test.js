import assert from 'node:assert/strict'
import test from 'node:test'
import { detectLanguage } from '../desktop/scripts/e2e/language-detect.mjs'

test('detectLanguage recognizes Japanese by kana', () => {
  assert.equal(detectLanguage('おはようございます、私の友達。今日はお元気ですか？'), 'Japanese')
})

test('detectLanguage recognizes Korean by hangul', () => {
  assert.equal(detectLanguage('좋은 아침이에요, 내 친구. 오늘 어떻게 지내세요?'), 'Korean')
})

test('detectLanguage recognizes French, German and Spanish by distinctive markers', () => {
  assert.equal(detectLanguage("Bonjour mon ami. Comment allez-vous aujourd'hui ? Je suis très heureux."), 'French')
  assert.equal(detectLanguage('Guten Morgen, mein Freund. Wie geht es dir heute? Ich bin sehr glücklich.'), 'German')
  assert.equal(detectLanguage('Buenos días, mi amigo. ¿Cómo estás hoy? Estoy muy feliz.'), 'Spanish')
})

test('detectLanguage rejects untranslated English and ambiguous text', () => {
  assert.equal(detectLanguage('Good morning, my friend. How are you today?'), 'unknown')
  assert.equal(detectLanguage(''), 'unknown')
  assert.equal(detectLanguage(null), 'unknown')
})
