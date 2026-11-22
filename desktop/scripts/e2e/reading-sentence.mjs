import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { clickWord, openPastedText, selectText, withState } from './reading-lookup.mjs'

const FIRST = 'The changes that the team proposed could reduce costs.'
const SECOND = 'The team will record the outcome.'
const FIRST_STRUCTURE = [
  { role: 'subject', text: 'The changes' }, { role: 'verb', text: 'could reduce' }, { role: 'object', text: 'costs' },
]
const SECOND_STRUCTURE = [
  { role: 'subject', text: 'The team' }, { role: 'verb', text: 'will record' }, { role: 'object', text: 'the outcome' },
]
const isStructure = (body) => body.messages[0].content.includes('Return only a JSON object with the key "structure"')

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
  await check('article sentence: a word waits for expansion and a phrase analyzes its complete sentence', async () => {
    const analyses = []
    const translations = []
    mock.setHandler(async ({ body, res }) => {
      const text = source(body)
      if (isStructure(body)) {
        analyses.push(text)
        reply(res, { structure: FIRST_STRUCTURE })
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
        assert.equal(analyses.length, 0, 'looking up a word must not pay for sentence analysis before expansion')
        assert.equal(await page.locator('#reading-sentence-toggle').evaluate((node) => node.open), false)
        await page.locator('#reading-sentence-toggle > summary').click()
        await page.locator('#reading-sentence-structure[data-status="done"]').waitFor()
        assert.deepEqual(analyses, [FIRST])
        assert.deepEqual(await page.locator('.reading-sentence-source').allTextContents(), [FIRST])
        assert.deepEqual((await highlights(page)).verb, ['could reduce'])
        await selectText(page, 'the team proposed')
        await page.locator('.translation-text').filter({ hasText: 'Selected meaning: the team proposed' }).waitFor()
        await page.locator('#reading-sentence-structure[data-status="done"]').waitFor()
        assert.equal(await page.locator('#reading-sentence-toggle').count(), 0, 'phrases show sentence structure directly')
        assert.deepEqual(await page.locator('.reading-sentence-source').allTextContents(), [FIRST])
        assert.deepEqual(analyses, [FIRST], 'another selection in the same complete sentence reuses its analysis')
        assert.deepEqual(translations, ['proposed', 'the team proposed'], 'translation stays scoped to selected text')
        await shot?.(page, 'main-reading-partial-sentence')
      })
    } finally { mock.resetHandler() }
  })

  await check('article sentence: partial boundaries across rich paragraphs keep both complete sentences and exact role offsets', async () => {
    const analyses = []
    mock.setHandler(async ({ body, res }) => {
      const text = source(body)
      if (isStructure(body)) {
        analyses.push(text)
        reply(res, { structure: [...FIRST_STRUCTURE, ...SECOND_STRUCTURE] })
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
        assert.deepEqual(await highlights(page), {
          subject: ['The changes', 'The team'], verb: ['could reduce', 'will record'], object: ['costs', 'the outcome'], complement: [],
        })
        assert.equal(await page.locator('.reading-sentence-source .sentence-mark').count(), 6)
        await shot?.(page, 'main-reading-cross-paragraph-sentences')
      })
    } finally { mock.resetHandler() }
  })

  await check('article sentence: requests start together and translation can finish before analysis', async () => {
    const pendingMeaning = gate()
    const pendingAnalysis = gate()
    let analyses = 0
    let translations = 0
    const sentence = 'The editor checked the final proof.'
    mock.setHandler(async ({ body, res }) => {
      if (isStructure(body)) {
        analyses += 1
        if (analyses === 1) {
          await pendingAnalysis.promise
          unavailable(res)
        } else reply(res, { structure: [
          { role: 'subject', text: 'The editor' }, { role: 'verb', text: 'checked' }, { role: 'object', text: 'the final proof' },
        ] })
      } else {
        translations += 1
        await pendingMeaning.promise
        reply(res, { translation: 'Checked the final proof.' })
      }
    })
    try {
      await withState(page, async () => {
        await openPastedText(page, sentence)
        await selectText(page, 'checked the final')
        await waitForRequests(() => translations === 1 && analyses === 1, 'both requests before either responds')
        await page.locator('#reading-sentence-structure[data-status="loading"]').waitFor()
        const meaning = page.locator('#reading-lookup-result .translation-text')
        assert.equal(await meaning.count(), 0)
        pendingMeaning.release()
        await meaning.filter({ hasText: 'Checked the final proof.' }).waitFor()
        const meaningNode = await meaning.elementHandle()
        assert.equal(await page.locator('#reading-sentence-structure').getAttribute('data-status'), 'loading')
        pendingAnalysis.release()
        await page.locator('#reading-sentence-structure[data-status="error"]').waitFor()
        assert.equal(await meaning.textContent(), 'Checked the final proof.')
        await page.locator('#reading-sentence-retry').click()
        await page.locator('#reading-sentence-structure[data-status="done"]').waitFor()
        assert.deepEqual(await page.locator('.reading-sentence-source').allTextContents(), [sentence])
        assert.equal(await meaningNode.evaluate((node) => node.isConnected), true)
        assert.equal(translations, 1, 'retrying analysis must not request another translation')
        assert.equal(analyses, 2)
      })
    } finally { pendingMeaning.release(); pendingAnalysis.release(); mock.resetHandler() }
  })

  await check('article sentence: analysis can finish first and survives translation retry and mode changes', async () => {
    const pendingMeaning = gate()
    const pendingGuide = gate()
    const sentence = 'The architect revised the original plan.'
    let analyses = 0
    let translations = 0
    let guides = 0
    mock.setHandler(async ({ body, res }) => {
      if (isStructure(body)) {
        analyses += 1
        reply(res, { structure: [{ role: 'subject', text: 'The architect' }, { role: 'verb', text: 'revised' }] })
      } else if (body.messages[0].content.includes('You are a patient reading tutor.')) {
        guides += 1
        await pendingGuide.promise
        reply(res, {
          hints: ['Notice what is being changed.', 'It is a plan.', 'Think about making edits.'],
          answer: { meaning: 'changed the plan', explanation: 'The verb describes making edits.', example: 'She revised the plan.' },
        })
      } else {
        translations += 1
        if (translations === 1) {
          await pendingMeaning.promise
          unavailable(res)
        } else reply(res, { translation: 'Changed the plan.' })
      }
    })
    try {
      await withState(page, async () => {
        await openPastedText(page, sentence)
        await selectText(page, 'revised the original')
        const structure = page.locator('#reading-sentence-structure[data-status="done"]')
        await structure.waitFor()
        const structureNode = await structure.elementHandle()
        assert.equal(await page.locator('#reading-lookup-result .translation-text').count(), 0, 'show analysis while translation is still pending')
        assert.deepEqual((await highlights(page)).verb, ['revised'])
        pendingMeaning.release()
        const retry = page.locator('#reading-lookup-retry')
        await retry.waitFor()
        assert.equal(await structure.locator('.reading-sentence-source').textContent(), sentence)
        await retry.click()
        assert.equal(await structure.locator('.reading-sentence-source').textContent(), sentence)
        await page.getByText('Changed the plan.', { exact: true }).waitFor()
        assert.equal(translations, 2)
        await page.locator('#reading-lookup-guide').click()
        await waitForRequests(() => guides === 1, 'the guided reading request')
        assert.equal(await structure.isVisible(), true, 'changing modes keeps the existing analysis visible')
        assert.deepEqual((await highlights(page)).verb, ['revised'])
        assert.equal(await page.locator('#reading-lookup-result .hint').count(), 0)
        pendingGuide.release()
        await page.locator('#reading-lookup-result .hint').first().waitFor()
        assert.equal(await structure.locator('.reading-sentence-source').textContent(), sentence)
        assert.equal(await structureNode.evaluate((node) => node.isConnected), true)
        assert.equal(analyses, 1, 'translation retry and mode changes reuse the existing analysis')
      })
    } finally { pendingMeaning.release(); pendingGuide.release(); mock.resetHandler() }
  })

  await check('article sentence: a new selection in the same sentence keeps the in-flight analysis', async () => {
    const pendingFirst = gate()
    const pendingAnalysis = gate()
    const sentence = 'A small group tested a new tool yesterday.'
    const translations = []
    let analyses = 0
    mock.setHandler(async ({ body, res }) => {
      const text = source(body)
      if (isStructure(body)) {
        analyses += 1
        await pendingAnalysis.promise
        reply(res, { structure: [{ role: 'subject', text: 'A small group' }, { role: 'verb', text: 'tested' }] })
      } else {
        translations.push(text)
        if (text === 'small group') await pendingFirst.promise
        reply(res, { translation: `Meaning: ${text}` })
      }
    })
    try {
      await withState(page, async () => {
        await openPastedText(page, sentence)
        await selectText(page, 'small group')
        await waitForRequests(() => translations.length === 1 && analyses === 1, 'the first lookup and analysis')
        await selectText(page, 'new tool', 0, { keepOpen: true })
        const currentMeaning = page.getByText('Meaning: new tool', { exact: true })
        await currentMeaning.waitFor()
        pendingFirst.release()
        pendingAnalysis.release()
        await page.locator('#reading-sentence-structure[data-status="done"]').waitFor()
        assert.equal(await currentMeaning.isVisible(), true)
        assert.deepEqual(translations, ['small group', 'new tool'])
        assert.equal(analyses, 1, 'reselection must keep the first analysis request in flight')
        assert.deepEqual((await highlights(page)).verb, ['tested'])
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
      if (isStructure(body)) {
        if (text === oldSentence) {
          firstStarted = true
          res.once('close', () => { firstClosed = true })
          await pending.promise
          reply(res, { structure: [{ role: 'subject', text: 'The researchers' }, { role: 'verb', text: 'reviewed' }] })
        } else reply(res, { structure: [{ role: 'subject', text: 'A second experiment' }, { role: 'verb', text: 'revealed' }] })
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
        assert.deepEqual((await highlights(page)).verb, ['revealed'])
      })
    } finally { pending.release(); mock.resetHandler() }
  })
}
