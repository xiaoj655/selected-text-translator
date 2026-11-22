import assert from 'node:assert/strict'
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

function gate() {
  let release
  const promise = new Promise((resolve) => { release = resolve })
  return { promise, release }
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

  await check('article sentence: analysis shows loading and supports its own retry while preserving the translation', async () => {
    const pending = gate()
    let analyses = 0
    let translations = 0
    const sentence = 'The editor checked the final proof.'
    mock.setHandler(async ({ body, res }) => {
      if (isStructure(body)) {
        analyses += 1
        if (analyses === 1) {
          await pending.promise
          if (res.destroyed) return
          res.writeHead(503, { 'Content-Type': 'application/json' })
          res.end('{"error":"temporarily unavailable"}')
        } else reply(res, { structure: [
          { role: 'subject', text: 'The editor' }, { role: 'verb', text: 'checked' }, { role: 'object', text: 'the final proof' },
        ] })
      } else {
        translations += 1
        reply(res, { translation: 'Checked the final proof.' })
      }
    })
    try {
      await withState(page, async () => {
        await openPastedText(page, sentence)
        await selectText(page, 'checked the final')
        await page.locator('#reading-sentence-structure[data-status="loading"]').waitFor()
        assert.equal(await page.locator('#reading-lookup-result .translation-text').textContent(), 'Checked the final proof.')
        await page.locator('.reading-sentence-status').getByText('Analyzing sentence…', { exact: true }).waitFor()
        pending.release()
        await page.locator('#reading-sentence-structure[data-status="error"]').waitFor()
        assert.equal(await page.locator('#reading-lookup-result .translation-text').textContent(), 'Checked the final proof.')
        await page.locator('#reading-sentence-retry').click()
        await page.locator('#reading-sentence-structure[data-status="done"]').waitFor()
        assert.deepEqual(await page.locator('.reading-sentence-source').allTextContents(), [sentence])
        assert.equal(translations, 1, 'retrying analysis must not request another translation')
        assert.equal(analyses, 2)
      })
    } finally { pending.release(); mock.resetHandler() }
  })

  await check('article sentence: a late analysis cannot replace the next selection', async () => {
    const pending = gate()
    const oldSentence = 'The researchers reviewed the first experiment.'
    const newSentence = 'A second experiment revealed a different answer.'
    mock.setHandler(async ({ body, res }) => {
      const text = source(body)
      if (isStructure(body)) {
        if (text === oldSentence) {
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
        await selectText(page, 'revealed a different')
        await page.locator('#reading-sentence-structure[data-status="done"]').waitFor()
        pending.release()
        await page.waitForTimeout(100)
        assert.equal(await page.locator('#reading-lookup-text').textContent(), 'revealed a different')
        assert.deepEqual(await page.locator('.reading-sentence-source').allTextContents(), [newSentence])
        assert.deepEqual((await highlights(page)).verb, ['revealed'])
      })
    } finally { pending.release(); mock.resetHandler() }
  })
}
