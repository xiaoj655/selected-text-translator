import test from 'node:test'
import assert from 'node:assert/strict'
import { formatStudyProgress, getStudyProgress, MASTERY_INTERVAL_DAYS } from '../src/vocabulary-progress.js'

const NOW = 1700000000000
const DAY_MS = 86400000

function entry(overrides = {}) {
  return { text: 'word', meaning: 'meaning', dueAt: NOW + DAY_MS, intervalDays: 0, reviewCount: 0, ...overrides }
}

test('getStudyProgress buckets due, learning and mastered entries', () => {
  const entries = [
    entry({ dueAt: NOW - 1 }),
    entry({ dueAt: NOW - DAY_MS, intervalDays: 14 }),
    entry({ dueAt: NOW + DAY_MS, intervalDays: 0 }),
    entry({ dueAt: NOW + 2 * DAY_MS, intervalDays: 3 }),
    entry({ dueAt: NOW + 7 * DAY_MS, intervalDays: MASTERY_INTERVAL_DAYS }),
    entry({ dueAt: NOW + 30 * DAY_MS, intervalDays: 30 }),
  ]
  assert.deepEqual(getStudyProgress(entries, NOW), { due: 2, learning: 2, mastered: 2, total: 6 })
})

test('getStudyProgress treats a mastered entry as due when its review is due', () => {
  const entries = [entry({ dueAt: NOW, intervalDays: 30, reviewCount: 5 })]
  assert.deepEqual(getStudyProgress(entries, NOW), { due: 1, learning: 0, mastered: 0, total: 1 })
})

test('getStudyProgress skips non-object entries without throwing', () => {
  const entries = [null, 'text', [], entry(), { dueAt: 'soon', intervalDays: 30 }]
  assert.deepEqual(getStudyProgress(entries, NOW), { due: 0, learning: 1, mastered: 1, total: 2 })
})

test('getStudyProgress handles empty and non-array input', () => {
  assert.deepEqual(getStudyProgress([], NOW), { due: 0, learning: 0, mastered: 0, total: 0 })
  assert.deepEqual(getStudyProgress(undefined, NOW), { due: 0, learning: 0, mastered: 0, total: 0 })
})

test('getStudyProgress falls back to current time for an invalid now', () => {
  const past = entry({ dueAt: Date.now() - DAY_MS })
  assert.equal(getStudyProgress([past], Number.NaN).due, 1)
})

test('formatStudyProgress renders all three counts', () => {
  assert.equal(formatStudyProgress({ due: 2, learning: 3, mastered: 4 }),
    '今日待复习 2 · 学习中 3 · 已掌握 4')
  assert.match(formatStudyProgress(), /今日待复习 0 · 学习中 0 · 已掌握 0/u)
})
