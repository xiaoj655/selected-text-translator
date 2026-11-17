import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ARCHIVE_FORMAT,
  ARCHIVE_VERSION,
  MAX_ARCHIVE_BYTES,
  buildLearningArchive,
  mergeHistoryEntries,
  migrateArchive,
  parseLearningArchive,
  planArchiveImport,
  serializeLearningArchive,
} from '../src/learning-archive.js';

test('buildLearningArchive includes all four learning data sections', () => {
  const archive = buildLearningArchive({
    vocabularyEntries: [{ id: 'v1', text: 'reluctant', meaning: '不情愿的' }],
    translationMemory: { 'translate\0auto\0qwen\0record': { translatedText: '唱片', savedAt: 1000 } },
    history: [{ id: 'h1', text: 'record', status: 'done' }],
    now: 12345,
  });
  assert.equal(archive.format, ARCHIVE_FORMAT);
  assert.equal(archive.version, ARCHIVE_VERSION);
  assert.equal(archive.exportedAt, 12345);
  assert.equal(archive.sections.vocabulary.entries.length, 1);
  assert.equal(Object.keys(archive.sections.translationMemory.entries).length, 1);
  assert.equal(archive.sections.history.entries.length, 1);
});

test('serialize/parse round-trip preserves all sections', () => {
  const archive = buildLearningArchive({
    vocabularyEntries: [{ id: 'v1', text: 'break the ice', meaning: '破冰' }],
    translationMemory: { key1: { translatedText: '破冰', savedAt: 2000 } },
    history: [{ id: 'h1', text: 'break the ice', status: 'done' }],
    now: 2000,
  });
  const parsed = parseLearningArchive(serializeLearningArchive(archive));
  assert.equal(parsed.vocabularyEntries[0].text, 'break the ice');
  assert.equal(parsed.translationMemory.key1.translatedText, '破冰');
  assert.equal(parsed.historyEntries[0].id, 'h1');
});

test('parseLearningArchive rejects invalid input', () => {
  assert.throws(() => parseLearningArchive(''), /file is empty/u);
  assert.throws(() => parseLearningArchive('{not json'), /unable to read/u);
  assert.throws(() => parseLearningArchive('{"format":"wrong"}'), /expected a Selected/u);
  const badVersion = buildLearningArchive({ now: 1 });
  badVersion.version = 99;
  assert.throws(() => parseLearningArchive(JSON.stringify(badVersion)), /expected a Selected/u);
});

test('parseLearningArchive skips malformed entries but keeps valid ones', () => {
  const archive = buildLearningArchive({
    vocabularyEntries: [
      { text: 'good', meaning: '好的' },
      { text: '', meaning: 'bad' },
      null,
    ],
    translationMemory: {
      good: { translatedText: '好', savedAt: 1 },
      bad: { translatedText: 2, savedAt: 1 },
    },
    history: [{ text: 'good' }, { text: '' }],
    now: 1,
  });
  const parsed = parseLearningArchive(serializeLearningArchive(archive));
  assert.equal(parsed.vocabularyEntries.length, 1);
  assert.equal(Object.keys(parsed.translationMemory).length, 1);
  assert.equal(parsed.historyEntries.length, 1);
});

test('parseLearningArchive enforces the size limit', () => {
  const huge = { format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, exportedAt: 1,
    sections: { vocabulary: { entries: [] }, translationMemory: { entries: {} }, history: { entries: [] } } };
  const text = JSON.stringify(huge) + 'x'.repeat(MAX_ARCHIVE_BYTES);
  assert.throws(() => parseLearningArchive(text), /8 MB/u);
});

test('mergeHistoryEntries deduplicates by id and caps history', () => {
  const existing = [{ id: 'a', text: 'a' }, { id: 'b', text: 'b' }];
  const incoming = [{ id: 'b', text: 'b updated' }, { id: 'c', text: 'c' }];
  const merged = mergeHistoryEntries(existing, incoming);
  assert.deepEqual(merged.map((entry) => entry.id), ['a', 'b', 'c']);
  assert.equal(merged[1].text, 'b');
  const many = Array.from({ length: 30 }, (_, index) => ({ id: `x${index}`, text: `x${index}` }));
  assert.equal(mergeHistoryEntries(many, []).length, 20);
});

test('migrateArchive normalizes legacy unversioned archives to version 1', () => {
  const legacy = buildLearningArchive({
    vocabularyEntries: [{ text: 'legacy', meaning: '旧版' }],
    now: 5,
  });
  delete legacy.version;
  delete legacy.sections.translationMemory;
  const migrated = migrateArchive(legacy);
  assert.equal(migrated.version, ARCHIVE_VERSION);
  assert.deepEqual(migrated.sections.translationMemory, { entries: {} });
  assert.equal(migrated.sections.vocabulary.entries.length, 1);
});

test('migrateArchive rejects newer versions with a clear upgrade message', () => {
  const future = buildLearningArchive({ now: 1 });
  future.version = 2;
  assert.throws(() => migrateArchive(future), /got version 2.*update Selected/u);
  assert.throws(() => migrateArchive({ format: 'wrong', version: 1 }), /expected a Selected/u);
});

test('parseLearningArchive accepts a legacy unversioned archive', () => {
  const legacy = buildLearningArchive({
    vocabularyEntries: [{ text: 'legacy word', meaning: '旧词' }],
    now: 7,
  });
  delete legacy.version;
  const parsed = parseLearningArchive(JSON.stringify(legacy));
  assert.equal(parsed.version, ARCHIVE_VERSION);
  assert.equal(parsed.vocabularyEntries[0].text, 'legacy word');
  assert.deepEqual(parsed.translationMemory, {});
  assert.deepEqual(parsed.historyEntries, []);
});

test('planArchiveImport protects existing data on conflicts and adds only new items', () => {
  const existing = {
    vocabularyEntries: [{ id: 'v1', text: 'shared', meaning: '现有释义', reviewCount: 3 }],
    translationMemory: { sharedKey: { translatedText: '现有译文', savedAt: 1 } },
    history: [{ id: 'h1', text: 'shared' }],
  };
  const incoming = {
    vocabularyEntries: [
      { id: 'v2', text: 'shared', meaning: '现有释义', reviewCount: 99 },
      { id: 'v3', text: 'brand new', meaning: '新增' },
    ],
    translationMemory: {
      sharedKey: { translatedText: '新译文', savedAt: 999 },
      newKey: { translatedText: '新记忆', savedAt: 999 },
    },
    historyEntries: [
      { id: 'h1', text: 'shared' },
      { id: 'h2', text: 'brand new' },
    ],
  };
  const plan = planArchiveImport(existing, incoming);
  assert.equal(plan.counts.vocabularyConflicts, 1);
  assert.equal(plan.counts.memoryConflicts, 1);
  assert.equal(plan.counts.vocabularyAdded, 1);
  assert.equal(plan.counts.memoryAdded, 1);
  assert.equal(plan.counts.historyAdded, 1);
  assert.equal(plan.counts.totalConflicts, 2);
  assert.equal(plan.vocabularyEntries.find((e) => e.text === 'shared').reviewCount, 3,
    'existing review progress must win on conflict');
  assert.ok(plan.vocabularyEntries.some((e) => e.text === 'brand new'));
  assert.equal(plan.translationMemory.sharedKey.translatedText, '现有译文',
    'existing translation must win on conflict');
  assert.equal(plan.translationMemory.newKey.translatedText, '新记忆');
  assert.deepEqual(plan.history.map((e) => e.id), ['h1', 'h2']);
});

test('planArchiveImport reports no conflicts for disjoint data', () => {
  const plan = planArchiveImport(
    { vocabularyEntries: [{ text: 'a', meaning: '甲' }] },
    { vocabularyEntries: [{ text: 'b', meaning: '乙' }], translationMemory: { k: { translatedText: '译', savedAt: 1 } } },
  );
  assert.equal(plan.counts.totalConflicts, 0);
  assert.equal(plan.counts.vocabularyAdded, 1);
  assert.equal(plan.counts.memoryAdded, 1);
  assert.equal(plan.vocabularyEntries.length, 2);
});
