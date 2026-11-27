import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveReaderSelection } from '../entry/src/main/ets/reader/ReaderDomain.ts'
import { buildReaderModelRequest, parseReaderModelResponse } from '../entry/src/main/ets/services/ReaderModelContract.ts'
import { READER_SYSTEM_PROMPT } from '../entry/src/main/ets/services/ReaderPrompt.ts'

function response(content) {
  return JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] })
}

test('word lookup identifies the precise repeated occurrence to the learning model', () => {
  const text = 'They record a record. We watch.'
  const selection = resolveReaderSelection(text, text.lastIndexOf('record'), 'word')
  const request = JSON.parse(buildReaderModelRequest('qwen3.8-flash', selection, READER_SYSTEM_PROMPT, true))
  const input = JSON.parse(request.messages[1].content)

  assert.equal(request.messages[0].content, READER_SYSTEM_PROMPT)
  assert.equal(request.stream, false)
  assert.equal(request.enable_thinking, false)
  assert.deepEqual(request.response_format, { type: 'json_object' })
  assert.deepEqual(input.selectedOccurrence, { before: 'They record a ', text: 'record', after: '.' })
  assert.equal(input.surroundingContext, 'They record a record.')
  assert.equal(input.surroundingContext.slice(input.contextStart, input.contextEnd), 'record')
})

test('word context remains bounded while keeping the exact selected word', () => {
  const text = `${'before '.repeat(450)}record${' after'.repeat(450)}.`
  const selection = resolveReaderSelection(text, text.indexOf('record'), 'word')
  const request = JSON.parse(buildReaderModelRequest('example-model', selection, READER_SYSTEM_PROMPT, false))
  const input = JSON.parse(request.messages[1].content)

  assert.equal(input.surroundingContext.length, 2400)
  assert.equal(input.surroundingContext.slice(input.contextStart, input.contextEnd), 'record')
  assert.equal(input.selectedOccurrence.before.length, 120)
  assert.equal(input.selectedOccurrence.after.length, 120)
})

test('sentence lookup sends the selected sentence without other context or vendor options', () => {
  const selection = resolveReaderSelection('First sentence. Another. Last.', 20, 'sentence')
  const request = JSON.parse(buildReaderModelRequest('qwen-via-compat-proxy', selection, READER_SYSTEM_PROMPT, false))
  assert.equal(request.enable_thinking, undefined)
  assert.deepEqual(JSON.parse(request.messages[1].content), {
    selectedText: 'Another.', selectionType: 'sentence', targetLanguage: 'English'
  })
})

test('reader responses extract meaning and optional lexical details from JSON and JSON fences', () => {
  const content = '```json\n{"meaning":" A written account ","phonetic":"/ˈrekərd/","contextualAnalysis":" A noun "}\n```'
  assert.deepEqual(parseReaderModelResponse(response(content), true), {
    meaning: 'A written account', phonetic: '/ˈrekərd/', contextualAnalysis: 'A noun'
  })
  assert.deepEqual(parseReaderModelResponse(response(content), false), {
    meaning: 'A written account', phonetic: '', contextualAnalysis: ''
  })
})

test('invalid responses never surface service body content', () => {
  for (const body of ['null', '{}', 'unstructured server diagnostic', response('not json'), response('{"meaning":" "}')]) {
    assert.throws(() => parseReaderModelResponse(body, true), {
      message: '模型没有返回可用的释义。请重试或检查设置中的模型。'
    })
  }
})
