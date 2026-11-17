import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MEMORY_MAX_AGE_MS,
  makeMemoryKey,
  memorySize,
  normalizeMemoryText,
  pruneMemory,
  readMemoryEntry,
  writeMemoryEntry,
} from '../src/translation-memory.js';

test('normalizeMemoryText collapses whitespace and lowercases', () => {
  assert.equal(normalizeMemoryText('  Hello   world  '), 'hello world');
  assert.equal(normalizeMemoryText(null), '');
  assert.equal(normalizeMemoryText('A\tB\nC'), 'a b c');
});

test('makeMemoryKey separates mode, target language, model and text', () => {
  const base = { text: 'Record', mode: 'translate', targetLanguage: 'auto', model: 'qwen-mt-flash' };
  const key = makeMemoryKey(base);
  assert.equal(key, makeMemoryKey({ ...base, text: '  record ' }));
  assert.notEqual(key, makeMemoryKey({ ...base, mode: 'guide' }));
  assert.notEqual(key, makeMemoryKey({ ...base, targetLanguage: 'Japanese' }));
  assert.notEqual(key, makeMemoryKey({ ...base, model: 'qwen3-flash' }));
  assert.notEqual(key, makeMemoryKey({ ...base, text: 'recording' }));
});

test('makeMemoryKey separates pinned source language so cached results cannot collide', () => {
  const base = { text: 'bank', mode: 'translate', targetLanguage: 'Chinese', model: 'qwen-mt-flash' };
  const english = makeMemoryKey({ ...base, sourceLanguage: 'English' });
  const japanese = makeMemoryKey({ ...base, sourceLanguage: 'Japanese' });
  assert.notEqual(english, japanese);
  assert.equal(english, makeMemoryKey({ ...base, sourceLanguage: 'English' }));
  assert.notEqual(english, makeMemoryKey({ ...base }));
  assert.equal(makeMemoryKey({ ...base }), makeMemoryKey({ ...base, sourceLanguage: 'auto' }));
});

test('writeMemoryEntry stores a result and readMemoryEntry retrieves it', () => {
  const key = makeMemoryKey({ text: 'record' });
  const memory = writeMemoryEntry({}, key, {
    translatedText: '唱片',
    lexical: { phonetic: '/rekərd/' },
    guide: null,
  });
  const found = readMemoryEntry(memory, key);
  assert.equal(found.translatedText, '唱片');
  assert.equal(found.lexical.phonetic, '/rekərd/');
  assert.ok(found.savedAt > 0);
  assert.equal(readMemoryEntry(memory, 'missing'), null);
  assert.equal(memorySize(memory), 1);
});

test('readMemoryEntry rejects expired and malformed entries', () => {
  const key = makeMemoryKey({ text: 'x' });
  assert.equal(readMemoryEntry({ [key]: { translatedText: 'y', savedAt: Date.now() - MEMORY_MAX_AGE_MS - 1 } }, key), null);
  assert.equal(readMemoryEntry({ [key]: { translatedText: 'y' } }, key), null);
  assert.equal(readMemoryEntry({ [key]: null }, key), null);
  assert.equal(readMemoryEntry(null, key), null);
});

test('writeMemoryEntry prunes to the entry cap keeping the newest', () => {
  let memory = {};
  for (let index = 0; index < 5; index += 1) {
    memory = writeMemoryEntry(memory, `key-${index}`, { translatedText: `v${index}` }, 3);
  }
  assert.equal(memorySize(memory), 3);
  assert.equal(readMemoryEntry(memory, 'key-4').translatedText, 'v4');
  assert.equal(readMemoryEntry(memory, 'key-2').translatedText, 'v2');
  assert.equal(readMemoryEntry(memory, 'key-0'), null);
});

test('pruneMemory respects max age and invalid inputs', () => {
  const now = Date.now();
  const memory = {
    fresh: { translatedText: 'a', savedAt: now - 1000 },
    stale: { translatedText: 'b', savedAt: now - MEMORY_MAX_AGE_MS - 1 },
    broken: { translatedText: 'c' },
  };
  const pruned = pruneMemory(memory, { now });
  assert.deepEqual(Object.keys(pruned), ['fresh']);
  assert.deepEqual(pruneMemory(null), {});
});
