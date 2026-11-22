import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHistory } from '../src/history.js'
import { sentenceStructure } from '../app/translation-result.js'

test('history restores sentence analysis after the old 4,000-character source boundary', () => {
  const directory = mkdtempSync(join(tmpdir(), 'stt-history-analysis-'))
  try {
    const text = 'Earlier context. '.repeat(260) + 'They stayed. To be ready'
    const start = text.lastIndexOf('stayed')
    assert.ok(start > 4000)
    const structure = [{ role: 'verb', start, end: start + 'stayed'.length }]
    const sentenceAnalysis = { fragments: [{ start: text.indexOf('To be ready'), end: text.length,
      explanation: 'The following main clause is missing.' }] }
    const history = createHistory(directory)
    assert.equal(history.save([{ id: 'long-source', text, status: 'done', mode: 'translate',
      translatedText: 'Translation.', structure, sentenceAnalysis }]), true)
    const [restored] = createHistory(directory).load()
    assert.equal(restored.text, text)
    assert.deepEqual(sentenceStructure(restored), structure)
    assert.deepEqual(restored.sentenceAnalysis, sentenceAnalysis)
    assert.equal(restored.text.slice(restored.sentenceAnalysis.fragments[0].start), 'To be ready')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
