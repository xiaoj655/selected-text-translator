import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGenericRequest,
  buildQwenMtRequest,
  createSelectedTextDiagnostics,
  extractGenericTranslation,
  getTargetLanguage,
  isQwenMtModel,
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

test('buildQwenMtRequest uses translation_options and no system message', () => {
  const payload = buildQwenMtRequest({
    model: 'qwen-mt-turbo',
    text: '你好',
    targetLanguage: 'English'
  });

  assert.equal(payload.model, 'qwen-mt-turbo');
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
});

test('buildGenericRequest uses fixed system prompt and omits translation_options', () => {
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
  assert.equal('translation_options' in payload, false);
  assert.equal('extra_body' in payload, false);
});

test('buildGenericRequest disables thinking for non-qwen-mt models starting with qwen', () => {
  const payload = buildGenericRequest({
    model: 'qwen3-235b-a22b',
    text: 'hello world'
  });

  assert.deepEqual(payload.extra_body, {
    enable_thinking: false
  });
});

test('buildGenericRequest does not set enable_thinking for qwen-mt family', () => {
  const payload = buildGenericRequest({
    model: 'qwen-mt-turbo',
    text: 'hello world'
  });

  assert.equal('extra_body' in payload, false);
});

test('extractGenericTranslation reads full JSON payload', () => {
  const result = extractGenericTranslation('{"translation":"你好世界"}');
  assert.equal(result, '你好世界');
});

test('extractGenericTranslation can parse translation field from partial JSON stream', () => {
  const result = extractGenericTranslation(
    'garbage{"translation":"line\\nwrapped"'
  );
  assert.equal(result, 'line\nwrapped');
});

test('createSelectedTextDiagnostics redacts text content to length + preview', () => {
  const value = createSelectedTextDiagnostics('0123456789012345678901234567890123456789');
  assert.deepEqual(value, {
    length: 40,
    preview: '012345678901234567890123456789012345'
  });
});
