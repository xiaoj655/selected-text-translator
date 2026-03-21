import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const contentSource = readFileSync(new URL('../src/content.js', import.meta.url), 'utf8');

test('content handles STREAM events as incremental updates only', () => {
  assert.match(
    contentSource,
    /if \(status === TRANSLATION_EVENT_STATUS\.STREAM\)\s*\{[\s\S]*renderSuccessCard\(state\.activeSelection\.text,\s*partial,\s*null\);[\s\S]*return;\s*\}/
  );
});

test('content handles SUCCESS events without requiring STREAM events', () => {
  assert.match(
    contentSource,
    /if \(status === TRANSLATION_EVENT_STATUS\.SUCCESS\)\s*\{[\s\S]*const translatedText = String\(payload\.translatedText \|\| ''\)\.trim\(\);[\s\S]*renderSuccessCard\(state\.activeSelection\.text,\s*translatedText,\s*lexicalDetails\);/
  );
});
