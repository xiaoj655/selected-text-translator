import test from 'node:test'
import assert from 'node:assert/strict'
import { createReadingControls } from '../src/settings-controls.js'

function createEl(value = '') {
  const listeners = new Map()
  return {
    value, textContent: '', disabled: false, options: [{ value: '', textContent: '自动选择' }],
    appendChild(option) { this.options.push(option) },
    addEventListener(type, fn) { listeners.set(type, fn) },
    async dispatch(type) { return listeners.get(type)?.() },
    hasListener(type) { return listeners.has(type) },
  }
}

async function withControls(callback) {
  const previousChrome = globalThis.chrome
  const previousDocument = globalThis.document
  const storage = { learning_model: 'generic', reading_mode: 'translate', speech_voice: 'Saved voice', speech_rate: 0.9 }
  const writes = []
  const changes = []
  let resolveVoices
  const voiceResult = new Promise((resolve) => { resolveVoices = resolve })
  const elements = Object.fromEntries(['learning_model', 'reading_mode', 'speech_voice', 'speech_rate',
    'preview-speech', 'speech-status'].map((id) => [id, createEl()]))
  globalThis.document = {
    getElementById(id) { return elements[id] }, createElement() { return createEl() },
  }
  globalThis.chrome = {
    runtime: { sendMessage() { return voiceResult } },
    storage: {
      onChanged: { addListener(fn) { changes.push(fn) } },
      sync: { async get() { return { ...storage } }, async set(values) { writes.push(values); Object.assign(storage, values) } },
    },
  }
  try {
    await callback({ elements, storage, writes, changes, resolveVoices })
  } finally {
    resolveVoices({ ok: true, voices: [] })
    await Promise.resolve()
    globalThis.chrome = previousChrome
    globalThis.document = previousDocument
  }
}

test('settings controls return and bind persistence before voice discovery finishes', async () => {
  await withControls(async ({ elements, writes }) => {
    const controls = await createReadingControls({ autoSave: true })
    assert.equal(elements.speech_rate.hasListener('change'), true)
    assert.equal(elements['preview-speech'].hasListener('click'), true)
    assert.equal(elements.speech_voice.value, 'Saved voice')
    elements.speech_rate.value = '1.2'
    await controls.persist()
    assert.deepEqual(writes, [{ speech_rate: 1.2 }])
  })
})

test('saving an unrelated setting cannot replace a newer reading mode from another tab', async () => {
  await withControls(async ({ elements, storage, writes }) => {
    const controls = await createReadingControls()
    storage.reading_mode = 'guide'
    elements.speech_rate.value = '1'
    await controls.persist()
    assert.equal(storage.reading_mode, 'guide')
    assert.equal(storage.speech_voice, 'Saved voice')
    assert.deepEqual(writes, [{ speech_rate: 1 }])
  })
})

test('external changes refresh clean fields and preserve an unsaved local edit', async () => {
  await withControls(async ({ elements, changes, writes }) => {
    const controls = await createReadingControls()
    elements.learning_model.value = 'local-model'
    changes[0]({ reading_mode: { newValue: 'guide' }, learning_model: { newValue: 'external-model' } }, 'sync')
    assert.equal(elements.reading_mode.value, 'guide')
    assert.equal(elements.learning_model.value, 'local-model')
    await controls.persist()
    assert.deepEqual(writes, [{ learning_model: 'local-model' }])
  })
})

test('late voice discovery keeps a choice made while the voice list was loading', async () => {
  await withControls(async ({ elements, resolveVoices, writes }) => {
    const controls = await createReadingControls()
    elements.speech_voice.value = ''
    resolveVoices({ ok: true, voices: [{ voiceName: 'Saved voice', lang: 'en-US' }] })
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(elements.speech_voice.value, '')
    await controls.persist()
    assert.deepEqual(writes, [{ speech_voice: '' }])
  })
})
