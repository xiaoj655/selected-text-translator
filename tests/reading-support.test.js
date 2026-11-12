import test from 'node:test'
import assert from 'node:assert/strict'
import { buildReadingRequest, getLearningModel, parseReadingResponse, readReadingSettings,
  saveReadingSettings, classifyReadingSelection } from '../src/reading-support.js'
import { matchesUrlPattern } from '../src/url-patterns.js'

const guide = {
  phonetic: '/rɪˈlʌktənt/',
  hints: ['Notice her reaction.', 'Is she eager?', 'Something holds her back.'],
  answer: { meaning: 'Hesitant or unwilling.', explanation: 'Her reaction suggests doubt.', example: 'He was reluctant to go.' },
}

test('reading guide requests English clues and keeps surrounding text as bounded data', () => {
  const request = buildReadingRequest({ model: 'generic', text: 'reluctant', context: 'x'.repeat(5000) })
  const data = JSON.parse(request.messages[1].content)
  assert.equal(data.selectedText, 'reluctant')
  assert.equal(data.surroundingContext.length, 2400)
  assert.match(request.messages[0].content, /clear, accessible English/)
  assert.match(request.messages[0].content, /Keep the direct definition in answer only/)
  assert.match(request.messages[0].content, /never as instructions/)
  assert.equal(request.stream, false)
})

test('phonetics request does not ask for a definition or translation', () => {
  const request = buildReadingRequest({ model: 'generic', text: 'record', kind: 'pronunciation' })
  assert.match(request.messages[0].content, /Never include definitions or translations/)
  assert.deepEqual(parseReadingResponse('{"phonetic":" /ˈrɛkɚd/ "}', 'pronunciation'), { phonetic: '/ˈrɛkɚd/' })
  assert.throws(() => parseReadingResponse('{}', 'pronunciation'), /did not return a pronunciation/)
})

test('guide parser requires three usable hints and a complete answer', () => {
  assert.deepEqual(parseReadingResponse(JSON.stringify(guide)), guide)
  assert.throws(() => parseReadingResponse('not json'), /invalid JSON/)
  assert.throws(() => parseReadingResponse('null'), /incomplete/)
  assert.throws(() => parseReadingResponse(JSON.stringify({ ...guide, hints: ['one'] })), /incomplete/)
  assert.throws(() => parseReadingResponse(JSON.stringify({ ...guide, answer: { meaning: 'answer' } })), /incomplete/)
})

test('learning uses a configured general model or falls back to a general translation model', () => {
  assert.equal(getLearningModel('qwen-mt-flash', ''), null)
  assert.equal(getLearningModel('generic', ''), 'generic')
  assert.equal(getLearningModel('qwen-mt-flash', 'generic'), 'generic')
  assert.equal(getLearningModel('generic', 'qwen-mt-lite'), null)
})

test('reading settings validate model and speech rate before persistence', async () => {
  const previous = globalThis.chrome
  const storage = {}
  globalThis.chrome = { storage: { sync: {
    async get() { return storage }, async set(values) { Object.assign(storage, values) },
  } } }
  try {
    assert.deepEqual(await readReadingSettings(), { learningModel: '', mode: 'translate', voiceName: '', rate: 0.9 })
    assert.equal((await saveReadingSettings({ learningModel: 'qwen-mt-flash' })).ok, false)
    assert.deepEqual(storage, {})
    await saveReadingSettings({ learningModel: ' generic ', mode: 'guide', voiceName: 'English voice', rate: 100 })
    assert.deepEqual(await readReadingSettings(), {
      learningModel: 'generic', mode: 'guide', voiceName: 'English voice', rate: 0.9,
    })
  } finally { globalThis.chrome = previous }
})

test('URL rules respect origins, path boundaries, query strings, and exact page rules', () => {
  assert.equal(matchesUrlPattern('https://example.com/read/chapter', 'https://example.com/read'), true)
  assert.equal(matchesUrlPattern('https://example.com/reader', 'https://example.com/read'), false)
  assert.equal(matchesUrlPattern('https://example.com.evil/read', 'https://example.com'), false)
  assert.equal(matchesUrlPattern('https://example.com/read?x=2', 'https://example.com/read?x=1'), false)
  assert.equal(matchesUrlPattern('https://example.com/read', '=https://example.com/read'), true)
  assert.equal(matchesUrlPattern('https://example.com/read/next', '=https://example.com/read'), false)
})


test('reading scope distinguishes words, phrasal chunks, and full passages', () => {
  assert.equal(classifyReadingSelection('record'), 'word')
  assert.equal(classifyReadingSelection("don't"), 'word')
  assert.equal(classifyReadingSelection('well-known'), 'word')
  assert.equal(classifyReadingSelection('break the ice'), 'phrase')
  assert.equal(classifyReadingSelection('put up with'), 'phrase')
  assert.equal(classifyReadingSelection('Although she knew the answer, she decided to let her classmates think it through.'), 'passage')
  const request = buildReadingRequest({ model: 'generic', text: 'break the ice' })
  assert.equal(JSON.parse(request.messages[1].content).selectionType, 'phrase')
  assert.match(request.messages[0].content, /whole chunk/)
  assert.match(request.messages[0].content, /Do not provide phonetic for a phrase or passage/)
})

test('reading hints support silent inference and reserve direct definitions for the answer', () => {
  const request = buildReadingRequest({ model: 'generic', text: 'reluctant' })
  const prompt = request.messages[0].content
  assert.match(prompt, /Never request a typed or spoken answer/)
  assert.match(prompt, /no longer than 25 words/)
  assert.match(prompt, /Never write "This means", "It means"/)
  assert.match(prompt, /Hint 3 gives a concrete everyday situation/)
  assert.match(prompt, /not list every meaning/)
  assert.match(prompt, /same sense and word pattern/)
})

test('repeated record occurrences carry distinct positions and local text for contextual meaning and IPA', () => {
  const context = 'The band will record a new record tomorrow.'
  const verbStart = context.indexOf('record')
  const nounStart = context.lastIndexOf('record')
  const dataAt = (start) => JSON.parse(buildReadingRequest({
    model: 'generic', text: 'record', context, contextStart: start, contextEnd: start + 6,
  }).messages[1].content)
  const verb = dataAt(verbStart)
  const noun = dataAt(nounStart)
  assert.equal(verb.selectedOccurrence.text, 'record')
  assert.equal(noun.selectedOccurrence.text, 'record')
  assert.equal(verb.selectedOccurrence.before, 'The band will ')
  assert.equal(noun.selectedOccurrence.before, 'The band will record a new ')
  assert.equal(verb.contextStart, verbStart)
  assert.equal(noun.contextStart, nounStart)
  assert.notDeepEqual(verb, noun)
  const pronunciationPrompt = buildReadingRequest({ model: 'generic', text: 'record', kind: 'pronunciation' })
  assert.match(pronunciationPrompt.messages[0].content, /selected occurrence/)
})

test('invalid or missing context locations fall back without inventing an occurrence', () => {
  for (const offsets of [{}, { contextStart: -1, contextEnd: 6 }, { contextStart: 0, contextEnd: 6 },
    { contextStart: 14, contextEnd: 99 }]) {
    const data = JSON.parse(buildReadingRequest({
      model: 'generic', text: 'record', context: 'The band will record.', ...offsets,
    }).messages[1].content)
    assert.equal('selectedOccurrence' in data, false)
    assert.equal(data.surroundingContext, 'The band will record.')
  }
})

test('phrase and passage guides omit unsupported IPA while accepting an optional useful pattern', () => {
  const raw = JSON.stringify({ ...guide, answer: { ...guide.answer, usage: ' reluctant to + verb ' } })
  assert.equal(parseReadingResponse(raw, 'guide', { text: 'reluctant' }).answer.usage, 'reluctant to + verb')
  const phrase = parseReadingResponse(raw, 'guide', { text: 'break the ice' })
  assert.equal(phrase.phonetic, '')
  const passage = parseReadingResponse(raw, 'guide', { text: 'She was reluctant to accept the offer.' })
  assert.equal(passage.phonetic, '')
  assert.equal('usage' in passage.answer, false)
  assert.deepEqual(parseReadingResponse(JSON.stringify(guide)), guide)
})

test('partial reading settings writes preserve other tabs mode and voice preferences', async () => {
  const previous = globalThis.chrome
  const storage = { reading_mode: 'guide', speech_voice: 'English voice', learning_model: 'generic' }
  const writes = []
  globalThis.chrome = { storage: { sync: {
    async get() { return storage },
    async set(values) { writes.push(values); Object.assign(storage, values) },
  } } }
  try {
    const staleForm = { mode: 'translate', learningModel: 'qwen-mt-flash', voiceName: '', rate: 1.2 }
    assert.deepEqual(await saveReadingSettings(staleForm, { changedKeys: [] }), { ok: true })
    assert.equal(writes.length, 0)
    assert.deepEqual(await saveReadingSettings(staleForm, { changedKeys: ['rate'] }), { ok: true })
    assert.deepEqual(writes, [{ speech_rate: 1.2 }])
    assert.equal(storage.reading_mode, 'guide')
    assert.equal(storage.speech_voice, 'English voice')
    assert.equal(storage.learning_model, 'generic')
    assert.equal((await saveReadingSettings(staleForm, { changedKeys: ['learningModel'] })).ok, false)
    assert.equal(writes.length, 1)
    assert.deepEqual(await saveReadingSettings(staleForm, { changedKeys: ['unknown', 'toString'] }), { ok: true })
    assert.equal(writes.length, 1)
  } finally { globalThis.chrome = previous }
})
