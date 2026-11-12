import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GENERIC_RESPONSE_FORMAT,
  buildGenericRequest,
  buildQwenMtRequest,
  createSelectedTextDiagnostics,
  extractGenericResponse,
  extractGenericTranslation,
  getTargetLanguage,
  isQwenMtModel,
  isQwenMtStreamingModel,
  isSingleWordInput,
  usesStructuredOutputForModel,
  TRANSLATION_SYSTEM_PROMPT
} from '../src/translation-contracts.js';

test('getTargetLanguage detects Chinese-containing text', () => {
  assert.equal(getTargetLanguage('你好 world'), 'English');
  assert.equal(getTargetLanguage('hello world'), 'Chinese');
});

test('isQwenMtModel detects qwen-mt family case-insensitively', () => {
  assert.equal(isQwenMtModel('qwen-mt-turbo'), true);
  assert.equal(isQwenMtModel('QWEN-MT-PLUS'), true);
  assert.equal(isQwenMtModel('gpt-4.1-mini'), false);
});

test('isQwenMtStreamingModel only enables stream for qwen-mt-flash and qwen-mt-lite', () => {
  assert.equal(isQwenMtStreamingModel('qwen-mt-flash'), true);
  assert.equal(isQwenMtStreamingModel('QWEN-MT-LITE'), true);
  assert.equal(isQwenMtStreamingModel(' qwen-mt-lite '), true);
  assert.equal(isQwenMtStreamingModel('qwen-mt-turbo'), false);
  assert.equal(isQwenMtStreamingModel('qwen-mt-plus'), false);
  assert.equal(isQwenMtStreamingModel('gpt-4.1-mini'), false);
});

test('usesStructuredOutputForModel only enables generic structured mode for non-qwen-mt models', () => {
  assert.equal(usesStructuredOutputForModel('gpt-4.1-mini'), true);
  assert.equal(usesStructuredOutputForModel('qwen3-235b-a22b'), true);
  assert.equal(usesStructuredOutputForModel('qwen-mt-turbo'), false);
});

test('buildQwenMtRequest enables streaming for qwen-mt-flash and keeps qwen-mt contract', () => {
  const payload = buildQwenMtRequest({
    model: 'qwen-mt-flash',
    text: '你好',
    targetLanguage: 'English'
  });

  assert.equal(payload.model, 'qwen-mt-flash');
  assert.equal(payload.stream, true);
  assert.deepEqual(payload.translation_options, {
    source_lang: 'auto',
    target_lang: 'English'
  });
  assert.deepEqual(payload.messages, [
    {
      role: 'user',
      content: '你好'
    }
  ]);
  assert.equal('response_format' in payload, false);
});

test('buildQwenMtRequest disables streaming for non-whitelisted qwen-mt models', () => {
  const payload = buildQwenMtRequest({
    model: 'qwen-mt-turbo',
    text: '你好',
    targetLanguage: 'English'
  });

  assert.equal(payload.stream, false);
  assert.deepEqual(payload.translation_options, {
    source_lang: 'auto',
    target_lang: 'English'
  });
  assert.equal(payload.messages[0].role, 'user');
});

test('buildGenericRequest uses fixed system prompt, json_object response_format, and no translation_options', () => {
  const payload = buildGenericRequest({
    model: 'gpt-4.1-mini',
    text: 'hello world'
  });

  assert.equal(payload.model, 'gpt-4.1-mini');
  assert.equal(payload.stream, false);
  assert.equal(payload.messages[0].role, 'system');
  assert.equal(payload.messages[0].content, TRANSLATION_SYSTEM_PROMPT);
  assert.equal(payload.messages[1].role, 'user');
  assert.equal(payload.messages[1].content, 'hello world');
  assert.deepEqual(payload.response_format, GENERIC_RESPONSE_FORMAT);
  assert.equal('translation_options' in payload, false);
  assert.equal('extra_body' in payload, false);
});

test('buildGenericRequest disables thinking for non-qwen-mt models starting with qwen', () => {
  const payload = buildGenericRequest({
    model: 'qwen3-235b-a22b',
    text: 'hello world'
  });

  assert.equal(payload.enable_thinking, false);
  assert.equal('extra_body' in payload, false);
});

test('buildGenericRequest does not set enable_thinking for qwen-mt family', () => {
  const payload = buildGenericRequest({
    model: 'qwen-mt-turbo',
    text: 'hello world'
  });

  assert.equal('extra_body' in payload, false);
  assert.equal('response_format' in payload, false);
});

test('non-qwen system prompt enforces JSON-only output and required translation contract', () => {
  assert.match(TRANSLATION_SYSTEM_PROMPT, /Return valid JSON only\./);
  assert.match(TRANSLATION_SYSTEM_PROMPT, /Do not output markdown code blocks/);
  assert.match(TRANSLATION_SYSTEM_PROMPT, /must always include "translation"/);
  assert.match(TRANSLATION_SYSTEM_PROMPT, /"phonetic"/);
  assert.match(TRANSLATION_SYSTEM_PROMPT, /"definitions"/);
  assert.match(TRANSLATION_SYSTEM_PROMPT, /"contextual_analysis"/);
});

test('extractGenericResponse accepts valid structured JSON and lexical optional fields for single-word input', () => {
  const result = extractGenericResponse(
    JSON.stringify({
      translation: '你好',
      phonetic: '/həˈləʊ/',
      definitions: [
        {
          pos: 'excl.',
          meaning: '你好',
          example: {
            source: 'hello there',
            target: '你好'
          }
        }
      ],
      contextual_analysis: '常见问候语。'
    }),
    {
      allowLexicalFields: true
    }
  );

  assert.equal(result.parseError, null);
  assert.equal(result.translation, '你好');
  assert.deepEqual(result.lexicalDetails, {
    phonetic: '/həˈləʊ/',
    definitions: [
      {
        pos: 'excl.',
        meaning: '你好',
        example: {
          source: 'hello there',
          target: '你好'
        }
      }
    ],
    contextual_analysis: '常见问候语。'
  });
  assert.deepEqual(result.invalidFields, []);
});

test('extractGenericResponse ignores optional lexical fields for non-single-word input', () => {
  const result = extractGenericResponse(
    JSON.stringify({
      translation: '你好世界',
      phonetic: '/həˈləʊ/',
      definitions: [
        {
          meaning: '你好'
        }
      ],
      contextual_analysis: '问候语。'
    }),
    {
      allowLexicalFields: false
    }
  );
  assert.equal(result.translation, '你好世界');
  assert.equal(result.lexicalDetails, null);
  assert.deepEqual(result.invalidFields, []);
});

test('extractGenericResponse normalizes malformed optional lexical fields without failing translation', () => {
  const result = extractGenericResponse(
    JSON.stringify({
      translation: '你好',
      phonetic: 123,
      definitions: [
        {
          pos: 'n.',
          meaning: '你好'
        },
        {
          pos: 'bad-item-without-meaning'
        }
      ],
      contextual_analysis: '  '
    }),
    {
      allowLexicalFields: true
    }
  );

  assert.equal(result.parseError, null);
  assert.equal(result.translation, '你好');
  assert.deepEqual(result.lexicalDetails, {
    definitions: [
      {
        pos: 'n.',
        meaning: '你好'
      }
    ]
  });
  assert.deepEqual(result.invalidFields.sort(), ['contextual_analysis', 'definitions', 'phonetic']);
});

test('extractGenericResponse fails clearly when required translation field is missing', () => {
  const result = extractGenericResponse(
    JSON.stringify({
      contextual_analysis: '无效响应'
    }),
    {
      allowLexicalFields: true
    }
  );
  assert.equal(result.translation, null);
  assert.equal(result.parseError, 'missing_translation');
});

test('extractGenericResponse reports invalid_json when model returns non-JSON content', () => {
  const result = extractGenericResponse('translation: 你好');
  assert.equal(result.translation, null);
  assert.equal(result.parseError, 'invalid_json');
});

test('extractGenericTranslation returns translation string from valid structured payload', () => {
  const result = extractGenericTranslation('{"translation":"你好世界"}');
  assert.equal(result, '你好世界');
});

test('isSingleWordInput recognizes words without treating punctuation or URLs as vocabulary', () => {
  assert.equal(isSingleWordInput('hello'), true);
  assert.equal(isSingleWordInput('你好'), true);
  assert.equal(isSingleWordInput('hello world'), false);
  assert.equal(isSingleWordInput('well-known'), true);
  assert.equal(isSingleWordInput("don't"), true);
  assert.equal(isSingleWordInput('Hello,world!'), false);
  assert.equal(isSingleWordInput('https://example.com'), false);
  assert.equal(isSingleWordInput('12345'), false);
  assert.equal(isSingleWordInput('  '), false);
});

test('createSelectedTextDiagnostics excludes all selected text', () => {
  const value = createSelectedTextDiagnostics('0123456789012345678901234567890123456789');
  assert.deepEqual(value, {
    length: 40
  });
});
