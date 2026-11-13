import test from 'node:test'
import assert from 'node:assert/strict'
import { createLibraryAudio, getEntrySpeechTargets } from '../src/library-audio.js'

function deferred() {
  let resolve
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

function createHarness(send = async () => ({ ok: true })) {
  const calls = []
  const statuses = []
  const audio = createLibraryAudio({
    send(type, payload) {
      calls.push({ type, payload })
      return send(type, payload)
    },
    onStatus(message, isError) { statuses.push({ message, isError }) },
  })
  return { audio, calls, statuses }
}

test('entry speech uses exact offsets to choose the saved occurrence of a repeated word', () => {
  const context = 'We will record the song. The record is ready.'
  const contextStart = context.lastIndexOf('record')
  const targets = getEntrySpeechTargets({ text: 'record', context, contextStart, contextEnd: contextStart + 6 })
  assert.equal(targets.word, 'record')
  assert.equal(targets.context, 'The record is ready.')
  assert.equal(targets.contextLabel, '读原句')
})

test('legacy null offsets locate a unique occurrence and keep ambiguous context intact', () => {
  const unique = getEntrySpeechTargets({
    text: 'reluctant', context: 'She was reluctant to leave. He waited.', contextStart: null, contextEnd: null,
  })
  assert.equal(unique.context, 'She was reluctant to leave.')
  assert.equal(unique.contextLabel, '读原句')
  const context = 'We will record the song. The record is ready.'
  const repeated = getEntrySpeechTargets({ text: 'record', context, contextStart: null, contextEnd: null })
  assert.equal(repeated.context, context)
  assert.equal(repeated.contextLabel, '读语境')
})

test('invalid saved positions use the complete context without guessing another occurrence', () => {
  const context = 'We will record the song. The record is ready.'
  const targets = getEntrySpeechTargets({ text: 'record', context, contextStart: 0, contextEnd: 6 })
  assert.equal(targets.context, context)
  assert.equal(targets.contextLabel, '读语境')
  assert.equal(getEntrySpeechTargets({ text: context, context }).context, '')
})

test('speech keeps the 1200 character limit without truncating words, examples, or context', () => {
  const exact = 'a'.repeat(1200)
  assert.equal(getEntrySpeechTargets({ text: exact, example: exact }).word, exact)
  assert.equal(getEntrySpeechTargets({ text: exact, example: exact }).example, exact)
  const long = 'a'.repeat(1201)
  const targets = getEntrySpeechTargets({ text: long, context: `record ${long} record`, example: long })
  assert.equal(targets.word, '')
  assert.equal(targets.example, '')
  assert.equal(targets.context, '')
  const longContext = `The record is ready. A${'a'.repeat(1300)}`
  assert.equal(getEntrySpeechTargets({ text: 'record', context: longContext }).context, 'The record is ready.')
})

test('each page has a unique client and toggling the same button stops its owned speech', async () => {
  const { audio, calls } = createHarness()
  const other = createHarness().audio
  assert.notEqual(audio.clientId, other.clientId)
  await audio.toggle('entry:word', 'record')
  assert.equal(audio.getActiveKey(), 'entry:word')
  assert.deepEqual(calls[0], {
    type: 'SPEAK_LIBRARY_TEXT',
    payload: { speechId: calls[0].payload.speechId, text: 'record', clientId: audio.clientId },
  })
  assert.ok(calls[0].payload.speechId)
  await audio.toggle('entry:word', 'record')
  assert.equal(audio.getActiveKey(), '')
  assert.deepEqual(calls[1], {
    type: 'STOP_SPEECH',
    payload: { speechId: calls[0].payload.speechId, clientId: audio.clientId },
  })
})

test('switching buttons waits for the old stop before starting the new text', async () => {
  const stopped = deferred()
  const { audio, calls } = createHarness((type) => type === 'STOP_SPEECH' ? stopped.promise : { ok: true })
  await audio.toggle('entry:word', 'record')
  const switching = audio.toggle('entry:context', 'The record is ready.')
  assert.deepEqual(calls.map(({ type }) => type), ['SPEAK_LIBRARY_TEXT', 'STOP_SPEECH'])
  assert.equal(audio.getActiveKey(), 'entry:context')
  stopped.resolve({ ok: true })
  await switching
  assert.deepEqual(calls.map(({ type }) => type), ['SPEAK_LIBRARY_TEXT', 'STOP_SPEECH', 'SPEAK_LIBRARY_TEXT'])
  assert.equal(calls[2].payload.text, 'The record is ready.')
  assert.notEqual(calls[2].payload.speechId, calls[0].payload.speechId)
})

test('stopping while speech is preparing immediately sends the cancellation', async () => {
  const started = deferred()
  const { audio, calls } = createHarness((type) => type === 'SPEAK_LIBRARY_TEXT' ? started.promise : { ok: true })
  const starting = audio.toggle('entry:word', 'record')
  const stopping = audio.stop()
  assert.deepEqual(calls.map(({ type }) => type), ['SPEAK_LIBRARY_TEXT', 'STOP_SPEECH'])
  assert.equal(calls[1].payload.speechId, calls[0].payload.speechId)
  started.resolve({ ok: false, message: 'Speech was cancelled.' })
  await Promise.all([starting, stopping])
  assert.equal(audio.getActiveKey(), '')
})

test('terminal events must match both the current speech and the page client', async () => {
  const { audio, calls } = createHarness()
  await audio.toggle('entry:word', 'record')
  const oldSpeechId = calls[0].payload.speechId
  await audio.toggle('entry:context', 'The record is ready.')
  const speechId = calls.at(-1).payload.speechId
  audio.handleEvent({ speechId: oldSpeechId, clientId: audio.clientId, status: 'end' })
  assert.equal(audio.getActiveKey(), 'entry:context')
  audio.handleEvent({ speechId, clientId: 'another-page', status: 'error' })
  assert.equal(audio.getActiveKey(), 'entry:context')
  audio.handleEvent({ speechId, clientId: audio.clientId, status: 'word' })
  assert.equal(audio.getActiveKey(), 'entry:context')
  audio.handleEvent({ speechId, clientId: audio.clientId, status: 'end' })
  assert.equal(audio.getActiveKey(), '')
})

test('rapid switches only start the most recently requested text', async () => {
  const started = deferred()
  const { audio, calls } = createHarness((type, payload) => {
    if (type === 'SPEAK_LIBRARY_TEXT' && payload.text === 'record') return started.promise
    return { ok: true }
  })
  const first = audio.toggle('entry:word', 'record')
  const second = audio.toggle('entry:context', 'The record is ready.')
  const third = audio.toggle('entry:example', 'Their new record comes out next week.')
  started.resolve({ ok: false })
  await Promise.all([first, second, third])
  assert.deepEqual(calls.filter(({ type }) => type === 'SPEAK_LIBRARY_TEXT').map(({ payload }) => payload.text),
    ['record', 'Their new record comes out next week.'])
  assert.equal(audio.getActiveKey(), 'entry:example')
})

test('an old speech error during a switch does not clear the new target or report its failure', async () => {
  const started = deferred()
  const { audio, calls, statuses } = createHarness((type, payload) => {
    if (type === 'SPEAK_LIBRARY_TEXT' && payload.text === 'record') return started.promise
    return { ok: true }
  })
  const first = audio.toggle('entry:word', 'record')
  const second = audio.toggle('entry:context', 'The record is ready.')
  audio.handleEvent({ speechId: calls[0].payload.speechId, clientId: audio.clientId, status: 'error' })
  assert.equal(audio.getActiveKey(), 'entry:context')
  assert.equal(statuses.some(({ isError }) => isError), false)
  started.resolve({ ok: false })
  await Promise.all([first, second])
  assert.equal(audio.getActiveKey(), 'entry:context')
  assert.equal(statuses.some(({ isError }) => isError), false)
  assert.equal(calls.at(-1).payload.text, 'The record is ready.')
})

test('send failures reset the play control and report an understandable status', async () => {
  for (const response of [() => { throw new Error('Internal transport error') }, () => ({ ok: false })]) {
    const { audio, statuses } = createHarness(response)
    await audio.toggle('entry:word', 'record')
    assert.equal(audio.getActiveKey(), '')
    assert.equal(statuses.at(-1).isError, true)
    assert.match(statuses.at(-1).message, /朗读.*系统语音.*重试/u)
    assert.doesNotMatch(statuses.at(-1).message, /Internal/u)
  }
})

test('a failed stop retains ownership and can be retried without starting a replacement', async () => {
  let shouldFailStop = true
  const { audio, calls, statuses } = createHarness((type) => ({ ok: type !== 'STOP_SPEECH' || !shouldFailStop }))
  await audio.toggle('entry:word', 'record')
  await audio.toggle('entry:context', 'The record is ready.')
  assert.equal(audio.getActiveKey(), 'entry:word')
  assert.equal(calls.filter(({ type }) => type === 'SPEAK_LIBRARY_TEXT').length, 1)
  assert.match(statuses.at(-1).message, /无法停止朗读.*再点一次/u)
  shouldFailStop = false
  await audio.toggle('entry:word', 'record')
  assert.equal(audio.getActiveKey(), '')
  assert.equal(calls.filter(({ type }) => type === 'STOP_SPEECH').length, 2)
})

test('terminal speech errors clear the control and invalid text never starts speech', async () => {
  const { audio, calls, statuses } = createHarness()
  await audio.toggle('entry:empty', '   ')
  await audio.toggle('entry:long', 'a'.repeat(1201))
  assert.equal(calls.length, 0)
  await audio.toggle('entry:word', 'record')
  audio.handleEvent({ speechId: calls[0].payload.speechId, clientId: audio.clientId, status: 'error' })
  assert.equal(audio.getActiveKey(), '')
  assert.equal(statuses.at(-1).isError, true)
  assert.match(statuses.at(-1).message, /朗读.*系统语音/u)
})
