import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createVocabularyStudy } from '../src/vocabulary-study.js'
import words from '../vendor/vocabulary/study-words.json' with { type: 'json' }

const minute = 60_000
const day = 24 * 60 * minute

function fixture(t, { history = [], saved = [] } = {}) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'stt-study-'))
  t.after(() => rmSync(userDataDir, { recursive: true, force: true }))
  let clock = Date.UTC(2026, 10, 27, 12)
  const open = () => createVocabularyStudy({ userDataDir, history: { load: () => history },
    getSavedVocabulary: async () => ({ entries: saved.map((text) => ({ text })) }), now: () => clock })
  return { open, advance: (ms) => { clock += ms } }
}

test('the packaged word list provides a usable supply of new words across difficulty bands', () => {
  const distinct = new Set(words.map(([word]) => word))
  assert.equal(distinct.size, words.length)
  for (const band of [1, 2, 3, 4]) assert.ok(words.filter((row) => row[1] === band).length >= 70)
  for (const [word, band, meaning, example] of words) {
    assert.match(word, /^[a-z]+$/u)
    assert.ok([1, 2, 3, 4].includes(band))
    assert.match(meaning, /\p{Script=Han}/u)
    assert.match(example, new RegExp(`\\b${word}\\b`, 'iu'))
  }
})

test('starting without history yields mixed tiers, then fresh feedback moves the recommended tier', async (t) => {
  const { open } = fixture(t)
  const study = open()
  const initial = await study.getPlan()
  assert.equal(initial.dueCount, 0)
  assert.deepEqual(initial.queue.map(({ band }) => band), [2, 2, 2, 1, 3])
  for (const card of initial.queue) assert.equal(await study.rate({ word: card.word, rating: 'known' }), true)
  const second = await study.getPlan()
  assert.equal(second.queue[0].band, 2)
  assert.equal(await study.rate({ word: second.queue[0].word, rating: 'known' }), true)
  const third = await open().getPlan()
  assert.deepEqual(third.queue.slice(0, 3).map(({ band }) => band), [3, 3, 3])
  assert.ok(third.queue.every((card) => !initial.queue.some((old) => old.word === card.word)))
})

test('recent first answers can replace earlier difficulty signals', async (t) => {
  const { open, advance } = fixture(t)
  const study = open()
  const middle = words.filter((row) => row[1] === 2).map(([word]) => word)
  for (const word of middle.slice(0, 12)) {
    advance(minute)
    assert.equal(await study.rate({ word, rating: 'new' }), true)
  }
  assert.equal((await study.getPlan()).queue.find((card) => card.mode === 'intro').band, 1)
  for (const word of middle.slice(12, 24)) {
    advance(minute)
    assert.equal(await study.rate({ word, rating: 'known' }), true)
  }
  assert.equal((await open().getPlan()).queue.find((card) => card.mode === 'intro').band, 3)
})

test('review timing survives reopening, retries are harmless, and due words come first', async (t) => {
  const { open, advance } = fixture(t)
  const study = open()
  const [{ word: newWord }, { word: familiar }] = (await study.getPlan()).queue
  assert.equal(await study.rate({ word: newWord, rating: 'new' }), true)
  assert.equal(await study.rate({ word: familiar, rating: 'familiar' }), true)
  assert.equal(await study.rate({ word: newWord, rating: 'remembered' }), false, 'rating before due must fail')
  assert.equal((await open().getPlan()).dueCount, 0)
  advance(10 * minute)
  const reopened = open()
  const due = await reopened.getPlan()
  assert.equal(due.queue[0].word, newWord)
  assert.equal(due.queue[0].mode, 'review')
  assert.equal(due.dueCount, 1)
  const [first, repeat] = await Promise.all([
    reopened.rate({ word: newWord, rating: 'remembered' }), reopened.rate({ word: newWord, rating: 'remembered' }),
  ])
  assert.deepEqual([first, repeat], [true, true])
  advance(day)
  const dueAgain = await reopened.getPlan()
  assert.deepEqual(dueAgain.queue.slice(0, 2).map((card) => card.word), [familiar, newWord])
  assert.equal(await reopened.rate({ word: newWord, rating: 'forgot' }), true)
  advance(10 * minute)
  assert.equal((await reopened.getPlan()).dueCount, 2)
})

test('available history personalizes the plan and duplicate activity cannot outweigh a saved word', async (t) => {
  const { open, advance } = fixture(t, { history: [
    { id: 'lookup-1', text: 'reluctant', status: 'done', sourceLanguage: 'English', createdAt: 100 },
    { id: 'not-a-lookup', text: 'accept', status: 'done', sourceLanguage: 'English', createdAt: 100, lookupExcluded: true },
  ], saved: ['deploy'] })
  const study = open()
  assert.equal((await study.getPlan()).queue[0].word, 'deploy')
  assert.equal(await study.recordLookup({ text: 'accept', lookupId: 'article-1' }), true)
  assert.equal(await study.recordLookup({ text: 'accept', lookupId: 'article-1' }), false)
  advance(day)
  assert.equal(await study.recordLookup({ text: 'accept', lookupId: 'article-2' }), true)
  assert.equal(await study.recordLookup({ text: 'not a single word', lookupId: 'article-3' }), false)
  const fresh = open()
  assert.equal((await fresh.getPlan()).queue[0].word, 'deploy')
  assert.equal(await fresh.rate({ word: 'deploy', rating: 'known' }), true)
  const { queue } = await fresh.getPlan()
  assert.equal(queue[0].word, 'accept')
  assert.equal(queue[0].fromHistory, true)
})
