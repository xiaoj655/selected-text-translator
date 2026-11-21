import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rename, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createStorage } from '../src/storage.js'
import { createReadingTutor } from '../src/reading-tutor.js'
import { createTutor } from '../src/tutor.js'

const DAY_MS = 86400000
const START = Date.UTC(2026, 10, 21, 12)
const PROVIDER = { base_url: 'https://example.test/v1/chat/completions', api_key: 'local-fixture',
  model: 'qwen-mt-flash', learning_model: 'qwen-flash' }
const FIRST_SENTENCES = ['They put off the match until Sunday.', 'Can we put off the move for a week?']
const REVIEW_SENTENCES = ['She put off the call until after dinner.', 'We put off hiring a new driver.']

function reply(sentences) {
  return {
    ok: true,
    async json() {
      const content = JSON.stringify({
        topic: '短语 put off',
        questions: sentences.map((sentence) => ({
          sentence, prompt: '他们做了什么？', choices: ['推迟', '取消', '立即开始'], correctIndex: 0,
          hint: '留意 put off 后的动作和时间。', explanation: '这里的 put off 表示推迟动作。',
        })),
      })
      return { choices: [{ message: { content } }] }
    },
  }
}

async function createFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'stt-tutor-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const storage = createStorage(dir)
  await storage.sync.set(PROVIDER)
  return { dir, storage }
}

test('plans use successful English sentences and phrases and deduplicate same-day events', async (t) => {
  const { storage } = await createFixture(t)
  const history = { load: () => [
    { id: 'first', text: 'put off', status: 'done', createdAt: START - DAY_MS },
    { id: 'second', text: '  put  off  ', status: 'done', createdAt: START - DAY_MS + 3000 },
    { id: 'sample', text: 'A sample you did not look up.', status: 'done', lookupExcluded: true },
    { id: 'word', text: 'record', status: 'done' },
    { id: 'failed', text: 'He did not go.', status: 'error' },
    { id: 'other', text: 'Buenos días amigo.', status: 'done', sourceLanguage: 'Spanish' },
  ] }
  const tutor = createTutor({ storage, history, now: () => START, fetcher: () => assert.fail('Unexpected request.') })
  await Promise.all([
    tutor.recordLookup({ id: 'third', text: 'put off', sourceLanguage: 'English', createdAt: START }),
    tutor.recordLookup({ id: 'fourth', text: 'We understand this sentence', sourceLanguage: 'English',
      guideType: 'sentence', createdAt: START }),
  ])
  const plan = await tutor.getPlan()
  assert.equal(plan.isConfigured, true)
  assert.equal(plan.candidateCount, 2)
  assert.equal(plan.source.text, 'put off')
  assert.equal(plan.source.kind, 'phrase')
  assert.equal(plan.source.occurrenceCount, 2)
})

test('lesson applies the configured model, persists performance, and reviews with new sentences', async (t) => {
  const { dir, storage } = await createFixture(t)
  const history = { load: () => [{ id: 'lookup', text: 'put off', status: 'done', createdAt: START }] }
  const requests = []
  const fetcher = async (url, options) => {
    assert.equal(url, PROVIDER.base_url)
    assert.equal(options.headers.Authorization, 'Bearer local-fixture')
    const body = JSON.parse(options.body)
    assert.equal(body.model, PROVIDER.learning_model)
    assert.match(body.messages[0].content, /Create an English reading comprehension lesson/)
    requests.push(JSON.parse(body.messages[1].content))
    return reply(requests.length === 1 ? FIRST_SENTENCES : REVIEW_SENTENCES)
  }
  let clock = START
  const now = () => clock
  const tutor = createTutor({ storage, history, fetcher, now })
  const { source } = await tutor.getPlan()
  assert.equal(requests.length, 0)
  const [lesson, repeated] = await Promise.all([tutor.startLesson(source.id), tutor.startLesson(source.id)])
  assert.equal(lesson.id, repeated.id)
  assert.deepEqual(requests, [{ sourceText: 'put off', sourceKind: 'phrase', previousSentences: [] }])
  const result = { lessonId: lesson.id, sourceId: source.id, outcome: 'independent' }
  const storageFile = join(dir, 'local.json')
  const storageBackup = join(dir, 'local-backup.json')
  await rename(storageFile, storageBackup)
  await mkdir(storageFile)
  await assert.rejects(tutor.recordResult(result))
  await rmdir(storageFile)
  await rename(storageBackup, storageFile)
  assert.deepEqual(await Promise.all([tutor.recordResult(result), tutor.recordResult(result)]), [true, true])

  const restarted = createTutor({ storage: createStorage(dir), history, fetcher, now })
  assert.equal((await restarted.getPlan()).source, null)
  assert.equal((await restarted.getPlan()).nextReviewAt, START + 3 * DAY_MS)
  clock += 3 * DAY_MS
  const review = (await restarted.getPlan()).source
  assert.equal(review.isReview, true)
  assert.equal(review.topic, lesson.topic)
  const practice = await restarted.startLesson(review.id)
  assert.deepEqual(practice.questions.map(({ sentence }) => sentence), REVIEW_SENTENCES)
  assert.deepEqual(requests[1].previousSentences, FIRST_SENTENCES)
  assert.equal(requests[1].reviewTopic, lesson.topic)
  await restarted.recordResult({ lessonId: practice.id, sourceId: review.id, outcome: 'hinted' })
  assert.equal((await restarted.getPlan()).nextReviewAt, clock + DAY_MS)
})

test('rejects an invalid lesson and its result, and permits a retry', async (t) => {
  const { storage } = await createFixture(t)
  const text = 'Although the water was cold, we went swimming.'
  const history = { load: () => [{ id: 'lookup', text, status: 'done', createdAt: START }] }
  let count = 0
  const fetcher = async () => reply(++count === 1 ? [text, FIRST_SENTENCES[0]] : FIRST_SENTENCES)
  const tutor = createTutor({ storage, history, now: () => START, fetcher })
  const { source } = await tutor.getPlan()
  assert.equal(source.kind, 'sentence')
  await assert.rejects(tutor.startLesson(source.id), /练习不完整或有重复/)
  await assert.rejects(tutor.recordResult({ sourceId: source.id, outcome: 'independent' }), /练习已失效/)
  const lesson = await tutor.startLesson(source.id)
  assert.equal(lesson.questions.length, 2)
})

test('article reading sends bounded discussion context and only displays verifiable quotations', async (t) => {
  const { storage } = await createFixture(t)
  const excerpt = 'Small batch sizes shorten the time it takes to identify a regression.'
  const baseArticle = {
    title: 'Small releases, better feedback', source: 'Engineering Blog', url: 'https://example.test/batches',
    publishedAt: '2026-11-21', excerpt,
  }
  const requests = []
  const tutor = createReadingTutor({ storage, fetcher: async (url, options) => {
    assert.equal(url, PROVIDER.base_url)
    const body = JSON.parse(options.body)
    assert.equal(body.model, PROVIDER.learning_model)
    assert.match(body.messages[0].content, /Read an English article together/)
    requests.push(JSON.parse(body.messages[1].content))
    const quote = requests.length === 1 ? 'shorten the time' : 'The study surveyed 10,000 engineers.'
    const content = JSON.stringify({
      reply: '小批发布会缩短定位回归问题所需的时间。', quote,
      followups: ['为什么会更快？', '为什么会更快？', '有什么代价？', '还能用于哪里？'],
    })
    return { ok: true, json: async () => ({ choices: [{ message: { content: [{ text: content }] } }] }) }
  } })

  const opening = await tutor.ask({ article: { ...baseArticle, text: excerpt } })
  assert.deepEqual(opening, {
    reply: '小批发布会缩短定位回归问题所需的时间。', quote: 'shorten the time',
    followups: ['为什么会更快？', '有什么代价？'],
  })
  assert.deepEqual(requests[0], {
    article: { title: baseArticle.title, source: baseArticle.source, url: baseArticle.url,
      publishedAt: baseArticle.publishedAt, text: excerpt, kind: 'feed_excerpt' },
    history: [], question: '',
  })

  const userText = 'The team chose fast feedback over full test coverage.'
  const followup = await tutor.ask({
    article: { text: userText.padEnd(12000, 'x') + ' omitted', excerpt },
    history: [...Array.from({ length: 9 }, () => ({ role: 'assistant', text: 'a'.repeat(4000) })),
      { role: 'system', text: 'This should remain outside the discussion context.' }],
    question: '  这里有什么取舍？  ',
  })
  assert.equal(followup.quote, '')
  assert.ok(requests[1].article.text.startsWith(userText))
  assert.equal(requests[1].article.text.length, 12000)
  assert.equal(requests[1].article.kind, 'pasted_text')
  assert.equal(requests[1].history.length, 7)
  assert.ok(requests[1].history.every((turn) => turn.role === 'assistant' && turn.text.length === 3000))
  assert.equal(requests[1].question, '这里有什么取舍？')
})

test('article reading validates configuration and surfaces malformed model replies', async () => {
  const article = { text: 'Feedback arrived too late to prevent the error.' }
  const missingSettings = createReadingTutor({
    storage: { sync: { get: async () => ({}) } },
    fetcher: () => assert.fail('Unconfigured reading must not make a network request.'),
  })
  await assert.rejects(missingSettings.ask({ article }), /请先在设置中配置/)
  await assert.rejects(missingSettings.ask({ article, question: 'a'.repeat(2501) }), /2500 个字符/)
  const malformed = createReadingTutor({
    storage: { sync: { get: async () => PROVIDER } },
    fetcher: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"quote":"OK"}' } }] }) }),
  })
  await assert.rejects(malformed.ask({ article }), /带读内容不完整/)
})
