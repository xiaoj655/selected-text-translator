import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import bankRows from '../vendor/vocabulary/study-words.json' with { type: 'json' }
import { getDayKey } from '../vendor/src/vocabulary-progress.js'

const DAY_MS = 86_400_000
const RETRY_MS = 10 * 60_000
const REVIEW_DAYS = [1, 3, 7, 14, 30]
const BANDS = [1, 2, 3, 4]
const INTRO_RATINGS = ['known', 'familiar', 'new']
const REVIEW_RATINGS = ['remembered', 'forgot']

function hashWord(word) {
  let value = 0
  for (let index = 0; index < word.length; index++) {
    value = (value * 31 + word.charCodeAt(index)) % 65_521
  }
  return value
}

const bank = bankRows.map(([word, band, meaning, example]) => ({ word, band, meaning, example }))
  .sort((a, b) => hashWord(a.word) - hashWord(b.word) || a.word.localeCompare(b.word, 'en'))
const wordsByText = new Map(bank.map((word) => [word.word, word]))

function wordFor(text) {
  return typeof text === 'string' ? wordsByText.get(text.trim().toLowerCase()) : undefined
}

function addLookup(lookups, word, id, timestamp) {
  const previous = Object.hasOwn(lookups, word) ? lookups[word] : null
  if (previous && (previous.id === id || previous.lastAt >= timestamp)) return false
  const differentDay = !previous || getDayKey(previous.lastAt) !== getDayKey(timestamp)
  lookups[word] = { id, lastAt: timestamp, count: (previous?.count || 0) + Number(differentDay) }
  return true
}

function initialState(history, clock) {
  const lookups = Object.create(null)
  const entries = history.load().filter((entry) => entry.status === 'done' && !entry.lookupExcluded
    && ['auto', 'english'].includes(String(entry.sourceLanguage || 'auto').toLowerCase()))
  for (const entry of entries.sort((a, b) => a.createdAt - b.createdAt)) {
    const word = wordFor(entry.text)?.word
    if (word && entry.id) addLookup(lookups, word, entry.id, Math.min(entry.createdAt, clock))
  }
  return { startingBand: null, lookups, progress: Object.create(null) }
}

function initialBand(lookups, savedWords) {
  const history = new Set([...Object.keys(lookups), ...savedWords])
  const bands = [...history].map((word) => wordsByText.get(word)?.band).filter(Boolean).sort((a, b) => a - b)
  return bands.length < 3 ? 2 : Math.min(3, bands[Math.floor((bands.length - 1) / 2)])
}

function recommendedBand(state, savedWords) {
  const introductions = Object.entries(state.progress)
    .sort(([, a], [, b]) => (b.firstSeenAt || 0) - (a.firstSeenAt || 0))
  const evidence = BANDS.map((band) => introductions
    .filter(([word]) => wordsByText.get(word)?.band === band).slice(0, 12)
    .map(([, progress]) => progress.firstRating))
  const mostly = (band, rating) => {
    const sample = evidence[band - 1]
    return sample.length >= 4 && sample.filter((item) => item === rating).length * 4 >= sample.length * 3
  }
  let band = state.startingBand ?? initialBand(state.lookups, savedWords)
  while (band > 1 && mostly(band, 'new') && !mostly(band - 1, 'known')) band--
  while (band < 4 && mostly(band, 'known') && !mostly(band + 1, 'new')) band++
  return band
}

function nextWords(state, savedWords, band, limit) {
  const unseen = bank.filter(({ word }) => !Object.hasOwn(state.progress, word))
  const personal = unseen.filter(({ word }) => savedWords.has(word) || Object.hasOwn(state.lookups, word))
    .sort((a, b) => Number(savedWords.has(b.word)) - Number(savedWords.has(a.word))
      || (state.lookups[b.word]?.count || 0) - (state.lookups[a.word]?.count || 0)
      || (state.lookups[b.word]?.lastAt || 0) - (state.lookups[a.word]?.lastAt || 0))

  const pick = []
  const selected = new Set()
  function add(item) {
    if (!item || selected.has(item.word) || pick.length >= limit) return
    pick.push(item)
    selected.add(item.word)
  }
  const closest = [...BANDS].sort((a, b) => Math.abs(a - band) - Math.abs(b - band))
  const adjacent = closest.filter((candidate) => Math.abs(candidate - band) === 1)
  if (adjacent.length === 2 && Object.keys(state.progress).length % 2) adjacent.reverse()
  // Save room to sample both nearby bands before the choices in the current band fill the session.
  const probes = limit >= 3 ? 2 : 0
  add(personal[0])
  for (const candidate of closest) {
    for (const item of unseen) {
      if (pick.length >= limit - probes) break
      if (item.band === candidate) add(item)
    }
  }
  for (let index = 0; index < probes; index++) {
    const candidate = adjacent[index % adjacent.length]
    add(unseen.find((item) => item.band === candidate && !selected.has(item.word)))
  }
  for (const candidate of closest) {
    for (const item of unseen) {
      if (pick.length >= limit) return pick
      if (item.band === candidate) add(item)
    }
  }
  return pick
}

function planFor(state, savedWords, clock) {
  const scheduled = Object.entries(state.progress)
    .filter(([word, progress]) => wordsByText.has(word) && progress.dueAt != null)
    .sort(([aWord, a], [bWord, b]) => a.dueAt - b.dueAt
      || hashWord(aWord) - hashWord(bWord) || aWord.localeCompare(bWord, 'en'))
  const dueItems = scheduled.filter(([, progress]) => progress.dueAt <= clock)
  const due = dueItems.slice(0, 6).map(([word]) => wordsByText.get(word))
  const upcoming = nextWords(state, savedWords, recommendedBand(state, savedWords), Math.min(5, 8 - due.length))
  const card = (item, mode) => ({ ...item, mode,
    fromHistory: savedWords.has(item.word) || Object.hasOwn(state.lookups, item.word) })
  return { queue: [...due.map((item) => card(item, 'review')), ...upcoming.map((item) => card(item, 'intro'))],
    dueCount: due.length, newCount: upcoming.length, remainingDue: dueItems.length - due.length,
    nextReviewAt: scheduled[dueItems.length]?.[1].dueAt ?? null }
}

export function createVocabularyStudy({ userDataDir, history, getSavedVocabulary, now = Date.now }) {
  const path = join(userDataDir, 'vocabulary-study.json')
  let queue = Promise.resolve()

  function read(clock) {
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return initialState(history, clock)
    }
  }

  function write(state) {
    mkdirSync(dirname(path), { recursive: true })
    const temporaryPath = `${path}.tmp`
    writeFileSync(temporaryPath, JSON.stringify(state))
    renameSync(temporaryPath, path)
  }

  function withState(action) {
    const result = queue.then(() => {
      const clock = now()
      return action(read(clock), clock)
    })
    queue = result.catch(() => {})
    return result
  }

  async function savedWords() {
    const { entries = [] } = await getSavedVocabulary()
    return new Set(entries.map((entry) => wordFor(entry.text)?.word).filter(Boolean))
  }

  function getPlan() {
    return withState(async (state, clock) => planFor(state, await savedWords(), clock))
  }

  function recordLookup(input) {
    const { text, lookupId } = input || {}
    const word = wordFor(text)?.word
    if (!word || typeof lookupId !== 'string' || !lookupId || lookupId.length > 120) return false
    return withState((state, clock) => {
      if (!addLookup(state.lookups, word, lookupId, clock)) return false
      write(state)
      return true
    })
  }

  function rate(input) {
    const { word, rating } = input || {}
    if (!wordsByText.has(word)) return false
    return withState(async (state, clock) => {
      const previous = Object.hasOwn(state.progress, word) ? state.progress[word] : null
      if (INTRO_RATINGS.includes(rating)) {
        if (previous) return previous.firstRating === rating
        if (state.startingBand === null) state.startingBand = initialBand(state.lookups, await savedWords())
        state.progress[word] = { firstRating: rating, firstSeenAt: clock, intervalDays: rating === 'familiar' ? 1 : 0,
          dueAt: rating === 'known' ? null : clock + (rating === 'familiar' ? DAY_MS : RETRY_MS) }
      } else if (REVIEW_RATINGS.includes(rating) && previous?.dueAt != null) {
        if (previous.dueAt > clock) return previous.lastReviewRating === rating
        const intervalDays = rating === 'forgot' ? 0
          : REVIEW_DAYS.find((days) => days > previous.intervalDays) ?? REVIEW_DAYS.at(-1)
        state.progress[word] = { ...previous, intervalDays, lastReviewRating: rating,
          dueAt: clock + (intervalDays ? intervalDays * DAY_MS : RETRY_MS) }
      } else return false
      write(state)
      return true
    })
  }

  return { getPlan, recordLookup, rate }
}
