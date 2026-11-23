import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { clickWord, openPastedText, selectText, withState } from './reading-lookup.mjs'

const FIRST = 'The changes that the team proposed could reduce costs.'
const SECOND = 'The team will record the outcome.'
const FIRST_PARAPHRASE = 'The team suggested changes that might make things cheaper.'
const FIRST_CLAUSE = 'This clause tells you which changes might reduce costs.'
const FIRST_STRUCTURE = [
  { role: 'subject', text: 'The changes' }, { role: 'verb', text: 'could reduce' }, { role: 'object', text: 'costs' },
]
const SECOND_STRUCTURE = [
  { role: 'subject', text: 'The team' }, { role: 'verb', text: 'will record' }, { role: 'object', text: 'the outcome' },
]
const isExplanation = (body) => body.messages[0].content.includes('You explain complete source sentences to a reader who needs to understand the thought.')

function source(body) {
  try { return JSON.parse(body.messages.at(-1).content).selectedText } catch { return body.messages.at(-1).content }
}

function reply(res, value) {
  if (res.destroyed) return
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }))
}

function unavailable(res) {
  if (res.destroyed) return
  res.writeHead(503, { 'Content-Type': 'application/json' })
  res.end('{"error":"temporarily unavailable"}')
}

function gate() {
  let release
  const promise = new Promise((resolve) => { release = resolve })
  return { promise, release }
}

async function waitForRequests(received, description) {
  const deadline = Date.now() + 6000
  while (!received()) {
    assert(Date.now() < deadline, `Timed out waiting for ${description}`)
    await delay(20)
  }
}

async function highlights(page) {
  return page.evaluate(() => Object.fromEntries(['subject', 'verb', 'object', 'complement'].map((role) => [
    role, [...(CSS.highlights.get(`reading-lookup-${role}`) || [])].map((range) => range.toString()),
  ])))
}

export async function verifyReadingSentenceScope({ page, mock, check, shot }) {
  await check('article sentence: a word and phrase both get a direct lookup and reuse the full sentence explanation', async () => {
    const analyses = []
    const translations = []
    mock.setHandler(async ({ body, res }) => {
      const text = source(body)
      if (isExplanation(body)) {
        analyses.push(JSON.parse(body.messages.at(-1).content))
        reply(res, { paraphrase: FIRST_PARAPHRASE, structure: FIRST_STRUCTURE,
          sentenceAnalysis: { clauses: [{ text: 'that the team proposed', explanation: FIRST_CLAUSE }] } })
      } else {
        translations.push(text)
        reply(res, { translation: `Selected meaning: ${text}` })
      }
    })
    try {
      await withState(page, async () => {
        await openPastedText(page, `A separate introduction is available. ${FIRST} ${SECOND}`)
        await clickWord(page, 'proposed')
        await page.locator('.translation-text').filter({ hasText: 'Selected meaning: proposed' }).waitFor()
        const overview = page.locator('.reading-sentence-paraphrase')
        const clause = page.getByText(FIRST_CLAUSE, { exact: true })
        await overview.waitFor()
        assert.equal(await overview.textContent(), FIRST_PARAPHRASE)
        assert.equal(await page.locator('#reading-sentence-toggle').evaluate((node) => node.open), false)
        assert.equal(await clause.isVisible(), false)
        assert.deepEqual((await highlights(page)).verb, [])
        assert.deepEqual(analyses.map((item) => item.selectedText), [FIRST])
        assert.equal(analyses[0].surroundingContext.slice(analyses[0].contextStart, analyses[0].contextEnd), FIRST)
        assert.equal(analyses[0].surroundingContext, `A separate introduction is available.\n\n${FIRST}\n\n${SECOND}`)
        await shot?.(page, 'main-reading-partial-sentence')
        await page.locator('#reading-sentence-toggle > summary').click()
        await page.locator('.reading-sentence-source').waitFor()
        await clause.waitFor()
        await page.waitForFunction(() => CSS.highlights.get('reading-lookup-verb')?.size === 1)
        assert.equal(await page.locator('.reading-sentence-source').textContent(), FIRST)
        await selectText(page, 'the team proposed', 0, { keepOpen: true })
        await page.locator('.translation-text').filter({ hasText: 'Selected meaning: the team proposed' }).waitFor()
        assert.equal(await overview.textContent(), FIRST_PARAPHRASE)
        assert.equal(analyses.length, 1, 'another selection in the same complete sentence reuses its analysis')
        assert.deepEqual(translations, ['proposed', 'the team proposed'], 'translation stays scoped to selected text')
      })
    } finally { mock.resetHandler() }
  })

  await check('article sentence: partial boundaries across rich paragraphs keep both complete sentences and exact role offsets', async () => {
    const analyses = []
    mock.setHandler(async ({ body, res }) => {
      const text = source(body)
      if (isExplanation(body)) {
        analyses.push(text)
        reply(res, { paraphrase: `${FIRST_PARAPHRASE} The team will write down the result.`, structure: [...FIRST_STRUCTURE, ...SECOND_STRUCTURE] })
      } else reply(res, { translation: `Selected meaning: ${text}` })
    })
    try {
      await withState(page, async () => {
        await openPastedText(page, `${FIRST}\n\n${SECOND}`)
        await page.locator('.reading-preview').first().evaluate((node) => {
          node.classList.add('reading-rich')
          node.innerHTML = '<p>A separate introduction is available.</p><p>The changes that <strong>the team</strong> proposed could reduce costs.</p>'
            + '<p>The team will <a href="https://example.com/record">record</a> the outcome.</p><p>An unrelated conclusion follows.</p>'
        })
        await selectText(page, 'the team proposed could reduce costs.The team will record')
        await page.locator('#reading-sentence-structure[data-status="done"]').waitFor()
        assert.deepEqual(analyses, [`${FIRST}\n\n${SECOND}`])
        assert.deepEqual(await page.locator('.reading-sentence-source').allTextContents(), [FIRST, SECOND])
        await page.locator('#reading-sentence-toggle > summary').click()
        await page.waitForFunction(() => CSS.highlights.get('reading-lookup-verb')?.size === 2)
        assert.deepEqual(await highlights(page), {
          subject: ['The changes', 'The team'], verb: ['could reduce', 'will record'], object: ['costs', 'the outcome'], complement: [],
        })
        assert.equal(await page.locator('.reading-sentence-source .sentence-mark').count(), 6)
        await shot?.(page, 'main-reading-cross-paragraph-sentences')
      })
    } finally { mock.resetHandler() }
  })

  await check('article sentence: a word starts both requests and its meaning survives sentence retry', async () => {
    const pendingMeaning = gate()
    const pendingAnalysis = gate()
    let analyses = 0
    let translations = 0
    const sentence = 'The editor checked the final proof.'
    mock.setHandler(async ({ body, res }) => {
      if (isExplanation(body)) {
        analyses += 1
        if (analyses === 1) {
          await pendingAnalysis.promise
          unavailable(res)
        } else reply(res, { paraphrase: 'The editor looked over the final version before publication.', structure: [
          { role: 'subject', text: 'The editor' }, { role: 'verb', text: 'checked' }, { role: 'object', text: 'the final proof' },
        ] })
      } else {
        translations += 1
        await pendingMeaning.promise
        reply(res, { translation: 'Looked over for mistakes.' })
      }
    })
    try {
      await withState(page, async () => {
        await openPastedText(page, sentence)
        await clickWord(page, 'checked')
        await waitForRequests(() => translations === 1 && analyses === 1, 'both requests before either responds')
        await page.locator('#reading-sentence-structure[data-status="loading"]').waitFor()
        const meaning = page.locator('#reading-lookup-result .translation-text')
        assert.equal(await meaning.count(), 0)
        pendingMeaning.release()
        await meaning.filter({ hasText: 'Looked over for mistakes.' }).waitFor()
        const meaningNode = await meaning.elementHandle()
        assert.equal(await page.locator('#reading-sentence-structure').getAttribute('data-status'), 'loading')
        pendingAnalysis.release()
        await page.locator('#reading-sentence-structure[data-status="error"]').waitFor()
        assert.equal(await meaning.textContent(), 'Looked over for mistakes.')
        await page.locator('#reading-sentence-retry').click()
        await page.locator('#reading-sentence-structure[data-status="done"]').waitFor()
        assert.deepEqual(await page.locator('.reading-sentence-source').allTextContents(), [sentence])
        assert.equal(await meaningNode.evaluate((node) => node.isConnected), true)
        assert.equal(translations, 1, 'retrying analysis must not request another translation')
        assert.equal(analyses, 2)
      })
    } finally { pendingMeaning.release(); pendingAnalysis.release(); mock.resetHandler() }
  })

  await check('article sentence: a grounded explanation succeeds without grammar and survives lookup retry and mode changes', async () => {
    const pendingMeaning = gate()
    const pendingGuide = gate()
    const sentence = 'So much for the original plan.'
    const paraphrase = 'The original plan has failed or is being abandoned.'
    const connection = 'This phrase signals that an earlier expectation no longer holds.'
    let analyses = 0
    let translations = 0
    let guides = 0
    mock.setHandler(async ({ body, res }) => {
      if (isExplanation(body)) {
        analyses += 1
        reply(res, { paraphrase, structure: [], sentenceAnalysis: { connections: [{ text: 'So much for', explanation: connection }] } })
      } else if (body.messages[0].content.includes('You are a patient reading tutor.')) {
        guides += 1
        await pendingGuide.promise
        reply(res, {
          hints: ['Notice the idiom at the start.', 'The speaker is dismissing a plan.', 'The plan no longer seems possible.'],
          answer: { meaning: 'forget about the plan', explanation: 'The plan will not work now.', example: 'So much for our trip.' },
        })
      } else {
        translations += 1
        if (translations === 1) {
          await pendingMeaning.promise
          unavailable(res)
        } else reply(res, { translation: 'So much for something.' })
      }
    })
    try {
      await withState(page, async () => {
        await openPastedText(page, sentence)
        await selectText(page, 'So much for')
        const structure = page.locator('#reading-sentence-structure[data-status="done"]')
        await structure.waitFor()
        const structureNode = await structure.elementHandle()
        assert.equal(await page.locator('#reading-lookup-result .translation-text').count(), 0, 'show analysis while translation is still pending')
        assert.equal(await structure.locator('.reading-sentence-paraphrase').textContent(), paraphrase)
        await structure.getByText(connection, { exact: true }).waitFor()
        assert.equal(await structure.locator('.sentence-mark').count(), 0)
        assert.equal(await structure.locator('#reading-sentence-retry').count(), 0)
        pendingMeaning.release()
        const retry = page.locator('#reading-lookup-retry')
        await retry.waitFor()
        assert.equal(await structure.locator('.reading-sentence-source').textContent(), sentence)
        await retry.click()
        assert.equal(await structure.locator('.reading-sentence-source').textContent(), sentence)
        await page.getByText('So much for something.', { exact: true }).waitFor()
        assert.equal(translations, 2)
        await page.locator('#reading-lookup-guide').click()
        await waitForRequests(() => guides === 1, 'the guided reading request')
        const sentenceDisclosure = page.locator('#reading-sentence-explanation')
        assert.equal(await sentenceDisclosure.evaluate((node) => node.open), false)
        assert.equal(await structure.isVisible(), false, 'guided reading keeps the explanation folded while solving')
        assert.equal(await page.locator('#reading-lookup-result .hint').count(), 0)
        pendingGuide.release()
        await page.locator('#reading-lookup-result .hint').first().waitFor()
        const answer = page.locator('#reading-lookup-meaning .answer')
        assert.equal(await answer.count(), 0, 'a completed guide leaves the answer hidden')
        await page.getByRole('button', { name: 'Reveal answer', exact: true }).click()
        await answer.getByText('forget about the plan', { exact: false }).waitFor()
        assert.equal(await structure.isVisible(), false, 'guide reveal leaves the independent explanation folded')
        await sentenceDisclosure.locator('summary').first().click()
        await structure.getByText(paraphrase, { exact: true }).waitFor()
        assert.equal(await structure.locator('.reading-sentence-source').textContent(), sentence)
        assert.equal(await structureNode.evaluate((node) => node.isConnected), true)
        assert.equal(analyses, 1, 'translation retry and mode changes reuse the existing analysis')
      })
    } finally { pendingMeaning.release(); pendingGuide.release(); mock.resetHandler() }
  })

  await check('article sentence: clicking a second word keeps the explanation in flight', async () => {
    const pendingFirst = gate()
    const pendingAnalysis = gate()
    const sentence = 'A small group tested a new tool yesterday.'
    const translations = []
    let analyses = 0
    mock.setHandler(async ({ body, res }) => {
      const text = source(body)
      if (isExplanation(body)) {
        analyses += 1
        await pendingAnalysis.promise
        reply(res, { paraphrase: 'Yesterday a few people tried out a new tool.', structure: [] })
      } else {
        translations.push(text)
        if (text === 'small') await pendingFirst.promise
        reply(res, { translation: `Meaning: ${text}` })
      }
    })
    try {
      await withState(page, async () => {
        await openPastedText(page, sentence)
        await clickWord(page, 'small')
        await waitForRequests(() => translations.length === 1 && analyses === 1, 'the first lookup and analysis')
        await clickWord(page, 'tool', 0, { keepOpen: true })
        const currentMeaning = page.getByText('Meaning: tool', { exact: true })
        await currentMeaning.waitFor()
        pendingFirst.release()
        pendingAnalysis.release()
        await page.locator('#reading-sentence-structure[data-status="done"]').waitFor()
        assert.equal(await currentMeaning.isVisible(), true)
        assert.deepEqual(translations, ['small', 'tool'])
        assert.equal(analyses, 1, 'reselection must keep the first analysis request in flight')
      })
    } finally { pendingFirst.release(); pendingAnalysis.release(); mock.resetHandler() }
  })

  await check('article sentence: a late analysis cannot replace the next selection', async () => {
    const pending = gate()
    let firstStarted = false
    let firstClosed = false
    const oldSentence = 'The researchers reviewed the first experiment.'
    const newSentence = 'A second experiment revealed a different answer.'
    mock.setHandler(async ({ body, res }) => {
      const text = source(body)
      if (isExplanation(body)) {
        if (text === oldSentence) {
          firstStarted = true
          res.once('close', () => { firstClosed = true })
          await pending.promise
          reply(res, { paraphrase: 'The researchers examined the first test.', structure: [] })
        } else reply(res, { paraphrase: 'Another test produced a different result.', structure: [] })
      } else reply(res, { translation: `Meaning: ${text}` })
    })
    try {
      await withState(page, async () => {
        await openPastedText(page, `${oldSentence} ${newSentence}`)
        await selectText(page, 'reviewed the first')
        await page.locator('#reading-sentence-structure[data-status="loading"]').waitFor()
        await waitForRequests(() => firstStarted, 'the analysis of the old selection')
        await selectText(page, 'revealed a different', 0, { keepOpen: true })
        await page.locator('#reading-sentence-structure[data-status="done"]').waitFor()
        await waitForRequests(() => firstClosed, 'cancellation of the old analysis')
        pending.release()
        assert.equal(await page.locator('#reading-lookup-text').textContent(), 'revealed a different')
        assert.deepEqual(await page.locator('.reading-sentence-source').allTextContents(), [newSentence])
        assert.equal(await page.locator('.reading-sentence-paraphrase').textContent(), 'Another test produced a different result.')
      })
    } finally { pending.release(); mock.resetHandler() }
  })
}
