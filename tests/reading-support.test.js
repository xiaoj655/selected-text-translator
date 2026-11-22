import test from 'node:test'
import assert from 'node:assert/strict'
import { buildReadingRequest, getLearningModel, parseReadingResponse, readReadingSettings,
  saveReadingSettings, classifyReadingSelection, supportsSentenceStructure,
  supportsTranslationStructure } from '../src/reading-support.js'
import { matchesUrlPattern } from '../src/url-patterns.js'

const guide = {
  phonetic: '/rɪˈlʌktənt/',
  hints: ['Notice her reaction.', 'Is she eager?', 'Something holds her back.'],
  answer: { meaning: 'Hesitant or unwilling.', explanation: 'Her reaction suggests doubt.', example: 'He was reluctant to go.' },
}

const sentenceGuide = {
  guideType: 'sentence',
  hints: [
    '“she let” starts the main action: she gives her classmates time.',
    '“Although” contrasts what she already knew with what she chose to do.',
  ],
  answer: {
    meaning: 'She knew the answer, but she chose to let her classmates work it out.',
    explanation: 'Knowing the answer did not make her answer for the others.',
  },
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
  assert.deepEqual(parseReadingResponse(JSON.stringify({ ...guide, guideType: 'term' })), guide)
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

test('sentence guides use the model scope even when a sentence without punctuation has a phrase hint', () => {
  const text = 'Although she knew the answer, she let her classmates think'
  const request = buildReadingRequest({ model: 'generic', text })
  assert.equal(classifyReadingSelection(text), 'phrase')
  assert.equal(JSON.parse(request.messages[1].content).selectionType, 'phrase')
  const prompt = request.messages[0].content
  assert.match(prompt, /selectionType is only a rough hint/)
  assert.match(prompt, /without final punctuation still needs guideType "sentence"/)
  assert.match(prompt, /directly explain who does what/)
  assert.match(prompt, /Never invent or alter quoted source text/)
  assert.match(prompt, /Do not ask questions, ask the learner to guess/)
  assert.match(prompt, /preserve all people, events, negation, time, and logical relationships/)
  const parsed = parseReadingResponse(JSON.stringify(sentenceGuide), 'guide', { text })
  assert.deepEqual(parsed, {
    ...sentenceGuide,
    phonetic: '',
    answer: { ...sentenceGuide.answer, example: '' },
  })
})

test('structure requests are opt-in and support complete English sentences within a selection', () => {
  const prompt = (text, options) => buildReadingRequest({ model: 'generic', text, ...options }).messages[0].content
  for (const text of ['She could stay', 'Dr. Rao is ready.', 'The rate is 2.5 percent.',
    'She left. We stayed.', 'She left. To be a successful scientist']) {
    assert.equal(supportsSentenceStructure(text), true)
    assert.doesNotMatch(prompt(text), /"structure" array/)
    assert.match(prompt(text, { includeSentenceStructure: true }), /"structure" array/)
  }
  for (const text of ['', 'record', '她接受了建议。']) {
    assert.equal(supportsSentenceStructure(text), false)
    assert.doesNotMatch(prompt(text, { includeSentenceStructure: true }), /"structure" array/)
  }
  assert.doesNotMatch(prompt('She left.', { sourceLanguage: 'French', includeSentenceStructure: true }), /"structure" array/)
  assert.doesNotMatch(prompt('She left.', { kind: 'pronunciation', includeSentenceStructure: true }), /"structure" array/)
})

function parseSentenceStructure(text, structure, options = {}) {
  return parseReadingResponse(JSON.stringify({ ...sentenceGuide, structure }), 'guide', {
    text, includeSentenceStructure: true, ...options,
  })
}

test('sentence guides sort grounded UTF-16 spans and lead with the clause hint', () => {
  const text = '🙂 Why didn’t they call me?'
  const result = parseSentenceStructure(text, [
    { role: 'object', text: 'me' },
    { role: 'subject', text: 'they' },
    { role: 'verb', text: 'call' },
    { role: 'verb', text: 'didn’t' },
  ])
  assert.deepEqual(result.structure, [
    { role: 'verb', start: 7, end: 13 },
    { role: 'subject', start: 14, end: 18 },
    { role: 'verb', start: 19, end: 23 },
    { role: 'object', start: 24, end: 26 },
  ])
  assert.deepEqual(result.hints, sentenceGuide.hints.slice(1))
  assert.equal(result.answer.meaning, sentenceGuide.answer.meaning)
})

test('main clauses retain real grammatical roles without forcing a subject or object', () => {
  for (const [text, parts] of [
    ['The change was approved', [['subject', 'The change'], ['verb', 'was approved']]],
    ['The change is ready.', [['subject', 'The change'], ['verb', 'is'], ['complement', 'ready']]],
    ["She'll wait.", [['subject', 'She'], ['verb', "'ll wait"]]],
    ['Sit down.', [['verb', 'Sit down']]],
  ]) {
    const structure = parts.map(([role, fragment]) => ({ role, text: fragment }))
    assert.deepEqual(parseSentenceStructure(text, structure).structure
      .map(({ role, start, end }) => [role, text.slice(start, end)]), parts)
  }
})

test('repeated fragments need a valid whole-span occurrence in the selected sentence', () => {
  const text = 'They record what others record.'
  const subject = { role: 'subject', text: 'They' }
  const verb = { role: 'verb', text: 'record' }
  assert.deepEqual(parseSentenceStructure(text, [subject, { ...verb, occurrence: 1 }]).structure, [
    { role: 'subject', start: 0, end: 4 },
    { role: 'verb', start: 5, end: 11 },
  ])
  for (const occurrence of [undefined, 0, 3, '1']) {
    const result = parseSentenceStructure(text, [subject, { ...verb, occurrence }])
    assert.deepEqual(result.structure, [])
    assert.deepEqual(result.hints, sentenceGuide.hints)
  }
})

test('corrupt or missing structure falls back to the existing guide', () => {
  const text = 'She rushed home.'
  const verb = { role: 'verb', text: 'rushed' }
  for (const structure of [undefined, [null, verb], [{ ...verb, text: 'rush' }], [{ ...verb, text: 'Rushed' }],
    [verb, { role: 'object', text: 'rushed home' }], [verb, { role: 'predicate', text: 'home' }],
    [{ role: 'subject', text: 'She' }]]) {
    const result = parseSentenceStructure(text, structure)
    assert.deepEqual(result.structure, [])
    assert.deepEqual(result.hints, sentenceGuide.hints)
  }
  assert.equal('structure' in parseSentenceStructure(text, [verb], { includeSentenceStructure: false }), false)
  assert.deepEqual(parseSentenceStructure('She rushed home. They stayed.', [verb]).structure,
    [{ role: 'verb', start: 4, end: 10 }])
})

const EXISTENTIAL_SELECTION = "There are some kinds of work that you can't do well without thinking differently from your peers. To be a successful scientist"
const EXISTENTIAL_STRUCTURE = [
  { role: 'subject', text: 'There' },
  { role: 'verb', text: 'are' },
  { role: 'complement', text: 'some kinds of work' },
]
const RELATIVE_CLAUSE = "that you can't do well without thinking differently from your peers"
const EXISTENTIAL_ANALYSIS = {
  connections: [
    { text: 'There are', explanation: 'This pattern says that these kinds of work exist. There is a dummy subject.' },
    { text: RELATIVE_CLAUSE, explanation: 'This clause describes work. You must think differently to do these jobs well.' },
  ],
  clauses: [{
    text: RELATIVE_CLAUSE,
    explanation: 'That points back to work and is the object of do.',
    structure: [
      { role: 'object', text: 'that' }, { role: 'subject', text: 'you' }, { role: 'verb', text: "can't do" },
    ],
  }],
  fragments: [{ text: 'To be a successful scientist', explanation: 'This is the start of another sentence. Its main clause is missing.' }],
}

function parseAnalysis(text, structure, sentenceAnalysis, options = {}) {
  return parseReadingResponse(JSON.stringify({ structure, sentenceAnalysis }), 'structure', {
    text, includeSentenceAnalysis: true, ...options,
  })
}

test('existential sentence retains its main clause beside a cut-off next sentence and offers grounded detail', () => {
  assert.equal(supportsSentenceStructure(EXISTENTIAL_SELECTION), true)
  assert.equal(supportsTranslationStructure(EXISTENTIAL_SELECTION), true)
  const prompt = buildReadingRequest({ model: 'generic', text: EXISTENTIAL_SELECTION, kind: 'structure' }).messages[0].content
  assert.match(prompt, /Skip incomplete beginnings or endings individually/)
  assert.match(prompt, /Do not finish a cut-off sentence or borrow missing words/)
  assert.match(prompt, /dummy subject/)
  assert.match(prompt, /never an object/)
  assert.match(prompt, /"sentenceAnalysis"/)

  const parsed = parseAnalysis(EXISTENTIAL_SELECTION, EXISTENTIAL_STRUCTURE, EXISTENTIAL_ANALYSIS)
  assert.deepEqual(parsed.structure.map(({ role, start, end }) => [role, EXISTENTIAL_SELECTION.slice(start, end)]), [
    ['subject', 'There'], ['verb', 'are'], ['complement', 'some kinds of work'],
  ])
  assert.ok(parsed.structure.every(({ end }) => end <= EXISTENTIAL_SELECTION.indexOf(' that')))
  const { connections, clauses, fragments } = parsed.sentenceAnalysis
  assert.equal(connections.length, 2)
  assert.equal(EXISTENTIAL_SELECTION.slice(clauses[0].start, clauses[0].end), RELATIVE_CLAUSE)
  assert.deepEqual(clauses[0].structure.map(({ role, start, end }) => [role, EXISTENTIAL_SELECTION.slice(start, end)]), [
    ['object', 'that'], ['subject', 'you'], ['verb', "can't do"],
  ])
  assert.equal(EXISTENTIAL_SELECTION.slice(fragments[0].start, fragments[0].end), 'To be a successful scientist')
  const guideResult = parseReadingResponse(JSON.stringify({
    ...sentenceGuide, structure: EXISTENTIAL_STRUCTURE, sentenceAnalysis: EXISTENTIAL_ANALYSIS,
  }), 'guide', { text: EXISTENTIAL_SELECTION, includeSentenceStructure: true })
  assert.deepEqual(guideResult.sentenceAnalysis, parsed.sentenceAnalysis)
})

test('main complements exclude grounded relative-clause detail even when the model returns the whole noun phrase', () => {
  const structure = EXISTENTIAL_STRUCTURE.map((part) => part.role === 'complement'
    ? { ...part, text: `some kinds of work ${RELATIVE_CLAUSE}` } : part)
  const expected = parseAnalysis(EXISTENTIAL_SELECTION, EXISTENTIAL_STRUCTURE, EXISTENTIAL_ANALYSIS)
  const actual = parseAnalysis(EXISTENTIAL_SELECTION, structure, EXISTENTIAL_ANALYSIS)
  assert.deepEqual(actual, expected)
  const raw = JSON.stringify({ ...sentenceGuide, structure, sentenceAnalysis: EXISTENTIAL_ANALYSIS })
  const guideResult = parseReadingResponse(raw, 'guide', {
    text: EXISTENTIAL_SELECTION, includeSentenceStructure: true,
  })
  assert.deepEqual(guideResult.structure, expected.structure)
  assert.deepEqual(parseReadingResponse(raw, 'structure', { text: EXISTENTIAL_SELECTION }), expected.structure)
  const ungrounded = { ...EXISTENTIAL_ANALYSIS, clauses: [{
    ...EXISTENTIAL_ANALYSIS.clauses[0], text: 'that you can do alone',
  }] }
  assert.equal(parseAnalysis(EXISTENTIAL_SELECTION, structure, ungrounded).structure.at(-1).end,
    EXISTENTIAL_SELECTION.indexOf(RELATIVE_CLAUSE) + RELATIVE_CLAUSE.length)
})

test('removing nested clauses splits a main subject into ordered verbatim UTF-16 ranges', () => {
  const text = '🙂 The scientist who discovered it and her colleague won a prize.'
  const clauses = [{
    text: 'who discovered it', explanation: 'This clause describes the scientist.',
    structure: [{ role: 'subject', text: 'who' }, { role: 'verb', text: 'discovered' }, { role: 'object', text: 'it' }],
  }]
  const parts = [{ role: 'subject', text: 'The scientist who discovered it and her colleague' },
    { role: 'verb', text: 'won' }, { role: 'object', text: 'a prize' }]
  const parsed = parseAnalysis(text, parts, { clauses })
  assert.deepEqual(parsed.structure, [
    { role: 'subject', start: 3, end: 16 },
    { role: 'subject', start: text.indexOf('and her colleague'), end: text.indexOf(' won') },
    { role: 'verb', start: text.indexOf('won'), end: text.indexOf('won') + 3 },
    { role: 'object', start: text.indexOf('a prize'), end: text.indexOf('a prize') + 7 },
  ])
  assert.deepEqual(parsed.structure.map(({ start, end }) => text.slice(start, end)),
    ['The scientist', 'and her colleague', 'won', 'a prize'])
  assert.deepEqual(parsed.sentenceAnalysis.clauses[0].structure.map(({ role, start, end }) => [role, text.slice(start, end)]),
    [['subject', 'who'], ['verb', 'discovered'], ['object', 'it']])
  assert.deepEqual(parseAnalysis(text, parts, undefined).structure.map(({ start, end }) => text.slice(start, end)),
    ['The scientist who discovered it and her colleague', 'won', 'a prize'])
})

test('clause subtraction drops fully covered main spans and preserves the main-verb requirement', () => {
  const text = 'The scientist who discovered it won.'
  const analysis = { clauses: [{ text: 'who discovered it', explanation: 'This describes the scientist.',
    structure: [{ role: 'subject', text: 'who' }, { role: 'verb', text: 'discovered' }, { role: 'object', text: 'it' }],
  }] }
  const parts = [{ role: 'subject', text: 'The scientist' }, { role: 'verb', text: 'who discovered it' }]
  assert.deepEqual(parseAnalysis(text, parts, analysis).structure, [])
  assert.deepEqual(parseAnalysis(text, [...parts, { role: 'verb', text: 'won' }], analysis).structure,
    [{ role: 'subject', start: 0, end: 13 }, { role: 'verb', start: 32, end: 35 }])
  const overlapping = [{ role: 'subject', text: 'The scientist who discovered it' }, { role: 'verb', text: 'discovered' }]
  assert.deepEqual(parseAnalysis(text, overlapping, analysis).structure, [],
    'subtraction must not rescue a top-level structure that fails strict overlap validation')
})

test('essential subject, object and complement clauses retain their main roles when explored', () => {
  for (const [text, mainParts, clauseText, clauseParts] of [
    ['I know that she left.', [['subject', 'I'], ['verb', 'know'], ['object', 'that she left']],
      'that she left', [['subject', 'she'], ['verb', 'left']]],
    ['What she said matters.', [['subject', 'What she said'], ['verb', 'matters']],
      'What she said', [['object', 'What'], ['subject', 'she'], ['verb', 'said']]],
    ['Her goal is to help others.', [['subject', 'Her goal'], ['verb', 'is'], ['complement', 'to help others']],
      'to help others', [['verb', 'to help'], ['object', 'others']]],
  ]) {
    const structure = mainParts.map(([role, fragment]) => ({ role, text: fragment }))
    const analysis = { clauses: [{ text: clauseText, explanation: 'This clause fills a role in the main sentence.',
      structure: clauseParts.map(([role, fragment]) => ({ role, text: fragment })),
    }] }
    const parsed = parseAnalysis(text, structure, analysis)
    assert.deepEqual(parsed.structure.map(({ role, start, end }) => [role, text.slice(start, end)]), mainParts)
    assert.equal(parsed.sentenceAnalysis.clauses.length, 1)
  }
})

test('multiple main clauses retain repeated subjects in source order with global occurrence counts', () => {
  const text = 'They work. They rest.'
  const result = parseSentenceStructure(text, [
    { role: 'verb', text: 'rest' }, { role: 'subject', text: 'They', occurrence: 2 },
    { role: 'verb', text: 'work' }, { role: 'subject', text: 'They', occurrence: 1 },
  ])
  assert.deepEqual(result.structure, [
    { role: 'subject', start: 0, end: 4 }, { role: 'verb', start: 5, end: 9 },
    { role: 'subject', start: 11, end: 15 }, { role: 'verb', start: 16, end: 20 },
  ])
  const repeated = 'They record what others record. They record what others record.'
  const analysis = parseAnalysis(repeated, [], { clauses: [{
    text: 'what others record', occurrence: 2, explanation: 'What is the thing being recorded.',
    structure: [{ role: 'object', text: 'what', occurrence: 2 },
      { role: 'subject', text: 'others', occurrence: 2 }, { role: 'verb', text: 'record', occurrence: 4 }],
  }] }).sentenceAnalysis
  assert.equal(analysis.clauses[0].start, repeated.lastIndexOf('what others record'))
  assert.equal(analysis.clauses[0].structure.at(-1).start, repeated.lastIndexOf('record'))
})

test('fragment-only selections can explain missing text without inventing main-clause labels', () => {
  const text = 'To be a successful scientist'
  const fragments = [{ text, explanation: 'The main clause has not been selected.' }]
  assert.deepEqual(parseAnalysis(text, [], { fragments }), {
    structure: [], sentenceAnalysis: { fragments: [{ start: 0, end: text.length, explanation: fragments[0].explanation }] },
  })
  assert.deepEqual(parseReadingResponse(JSON.stringify({ structure: [] }), 'structure', { text }), [])
})

test('invalid optional notes and subordinate spans cannot erase valid main structure or valid siblings', () => {
  const valid = EXISTENTIAL_ANALYSIS.clauses[0]
  const result = parseAnalysis(EXISTENTIAL_SELECTION, EXISTENTIAL_STRUCTURE, {
    connections: [null, { text: 'invented quote', explanation: 'Unknown.' },
      { text: 'work', explanation: '' }, { text: 'work', explanation: 'x'.repeat(601) },
      ...EXISTENTIAL_ANALYSIS.connections],
    clauses: [
      { ...valid, text: 'that you can do well' },
      { ...valid, structure: [{ role: 'verb', text: 'are' }] },
      { ...valid, structure: [{ role: 'verb', text: "can't do" }, { role: 'object', text: "can't do well" }] },
      { ...valid, structure: [{ role: 'subject', text: 'you' }] },
      valid,
    ],
    fragments: [false, { text: ' To be a successful scientist', explanation: 'Bad spacing.' },
      ...EXISTENTIAL_ANALYSIS.fragments],
  })
  const validResult = parseAnalysis(EXISTENTIAL_SELECTION, EXISTENTIAL_STRUCTURE, EXISTENTIAL_ANALYSIS)
  assert.deepEqual(result, validResult)
  assert.deepEqual(parseAnalysis(EXISTENTIAL_SELECTION, EXISTENTIAL_STRUCTURE, { connections: [{}] }), {
    structure: validResult.structure, sentenceAnalysis: undefined,
  })
})

test('analysis quotes use whole-fragment global occurrences and UTF-16 offsets', () => {
  const text = '🙂 They work. They rest.'
  const note = { text: 'They', explanation: 'This refers to the same people.' }
  for (const occurrence of [undefined, 0, 3, '2']) {
    assert.equal(parseAnalysis(text, [], { connections: [{ ...note, occurrence }] }).sentenceAnalysis, undefined)
  }
  assert.deepEqual(parseAnalysis(text, [], { connections: [{ ...note, occurrence: 2 }] }).sentenceAnalysis.connections,
    [{ start: 14, end: 18, explanation: note.explanation }])
  assert.equal(parseAnalysis(text, [], { connections: [{ text: 'he', explanation: 'Cannot match inside They.' }] }).sentenceAnalysis, undefined)
})

test('optional analysis deduplicates quotes, caps displayed items, and remains opt-in for guides', () => {
  const text = 'One two three four five six seven.'
  const connections = ['One', 'One', 'two', 'three', 'four', 'five'].map((word) => ({ text: word, explanation: word }))
  assert.equal(parseAnalysis(text, [], { connections }).sentenceAnalysis.connections.length, 3)
  const result = parseReadingResponse(JSON.stringify({ ...sentenceGuide,
    sentenceAnalysis: { connections: EXISTENTIAL_ANALYSIS.connections },
  }), 'guide', { text: EXISTENTIAL_SELECTION })
  assert.equal('sentenceAnalysis' in result, false)
})

test('sentence guides accept one to three useful hints without requiring an example', () => {
  for (const count of [1, 2, 3]) {
    const hints = ['Main action.', 'A useful connection.', 'A difficult reference.'].slice(0, count)
    const parsed = parseReadingResponse(JSON.stringify({ ...sentenceGuide, hints }), 'guide', { text: 'She stays.' })
    assert.deepEqual(parsed.hints, hints)
    assert.equal(parsed.answer.example, '')
    assert.equal(parsed.guideType, 'sentence')
  }
  for (const hints of [[], ['One.', 'Two.', 'Three.', 'Four.']]) {
    assert.throws(() => parseReadingResponse(JSON.stringify({ ...sentenceGuide, hints }), 'guide', {
      text: 'She stays.',
    }), /incomplete/)
  }
  for (const field of ['meaning', 'explanation']) {
    for (const value of [undefined, '', '  ']) {
      const answer = { ...sentenceGuide.answer, [field]: value }
      assert.throws(() => parseReadingResponse(JSON.stringify({ ...sentenceGuide, answer }), 'guide', {
        text: 'She stays.',
      }), /incomplete/)
    }
  }
})

test('single words keep term validation when the model incorrectly returns a sentence guide', () => {
  assert.throws(() => parseReadingResponse(JSON.stringify(sentenceGuide), 'guide', { text: 'reluctant' }), /incomplete/)
  const withThreeHints = { ...sentenceGuide, hints: guide.hints }
  assert.throws(() => parseReadingResponse(JSON.stringify(withThreeHints), 'guide', {
    text: 'reluctant',
  }), /incomplete/)
  assert.deepEqual(parseReadingResponse(JSON.stringify({ ...guide, guideType: 'sentence' }), 'guide', {
    text: 'reluctant',
  }), guide)
})

test('sentence guides suppress phonetics and usage, including old passage responses without a scope', () => {
  const raw = JSON.stringify({
    ...sentenceGuide,
    phonetic: '/wrong/',
    answer: { ...sentenceGuide.answer, usage: 'not a sentence pattern', example: ' A legacy example. ' },
  })
  const parsed = parseReadingResponse(raw, 'guide', { text: 'She would rather stay home' })
  assert.equal(parsed.phonetic, '')
  assert.equal('usage' in parsed.answer, false)
  assert.equal(parsed.answer.example, 'A legacy example.')
  const legacy = { hints: sentenceGuide.hints, answer: sentenceGuide.answer }
  assert.deepEqual(parseReadingResponse(JSON.stringify(legacy), 'guide', { text: 'She stays.' }), {
    ...sentenceGuide,
    phonetic: '',
    answer: { ...sentenceGuide.answer, example: '' },
  })
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
