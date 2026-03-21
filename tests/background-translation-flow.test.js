import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const backgroundSource = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');

test('background routes qwen-mt translation by requestBody.stream', () => {
  assert.match(backgroundSource, /const translationResult = isQwenMtRequest/);
  assert.match(backgroundSource, /\?\s*requestBody\.stream/);
  assert.match(backgroundSource, /translation:\s*await consumeStream\(/);
  assert.match(backgroundSource, /translation:\s*await consumeQwenMtNonStreamResponse\(/);
});

test('background includes non-stream qwen-mt parse failures for malformed responses', () => {
  assert.match(backgroundSource, /async function consumeQwenMtNonStreamResponse/);
  assert.match(backgroundSource, /qwen-mt non-stream response is not valid JSON\./);
  assert.match(backgroundSource, /qwen-mt non-stream response did not include translated content\./);
  assert.match(backgroundSource, /debugLog\('qwen_non_stream_parse_failed'/);
});

test('background emits STREAM events only in stream consumer path', () => {
  const streamStatusRefs = [...backgroundSource.matchAll(/TRANSLATION_EVENT_STATUS\.STREAM/g)];
  assert.equal(streamStatusRefs.length, 1);
  assert.match(backgroundSource, /async function consumeStream[\s\S]*TRANSLATION_EVENT_STATUS\.STREAM/);
});
