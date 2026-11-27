import assert from 'node:assert/strict'
import { isArticleExplanation } from './mock-api.mjs'
import { clickWord, openPastedText, selectText } from './reading-lookup.mjs'

const TARGET = 'english-explanation'
const INPUT = 'The committee shelved the proposal.'
const WORD = 'shelved'
const PARAPHRASE = 'The committee decided to set the proposal aside.'
const DEFINITION = 'put aside and stopped considering for now'

function reply(res, body, value) {
  const content = JSON.stringify(value)
  if (body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`)
    return
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { content } }] }))
}

function userInput(body) {
  const text = body.messages.at(-1).content
  try { return JSON.parse(text) } catch { return { selectedText: text } }
}

export async function verifyEnglishExplanation({ page, mock, check, shot, openSettings }) {
  await check('English explanation: persists and explains typed text and article selections', async () => {
    const target = page.locator('#lang-target')
    const settingsTarget = page.locator('#opt-target-language')
    const input = page.locator('#input')
    const originalTarget = await target.inputValue()
    const received = new Map()
    mock.setHandler(async ({ body, res, defaultResponse }) => {
      const data = userInput(body)
      const sentence = isArticleExplanation(body)
      const explainsInEnglish = body.messages[0].content.includes('Explain only selectedText in plain, natural English.')
      if (![WORD, INPUT].includes(data.selectedText) || (!sentence && !explainsInEnglish)) {
        return defaultResponse({ body, res })
      }
      received.set(sentence ? 'sentence' : data.selectedText, body)
      reply(res, body, sentence ? { paraphrase: PARAPHRASE }
        : { translation: data.selectedText === WORD ? DEFINITION : PARAPHRASE })
    })
    try {
      await openSettings(page)
      await settingsTarget.selectOption({ label: 'Explain in English' })
      assert.equal(await target.inputValue(), TARGET)
      await page.locator('#btn-close-settings').click()
      await page.waitForFunction(async (value) => (await chrome.storage.sync.get('desktop_target_language'))
        .desktop_target_language === value, TARGET)

      await page.reload()
      await page.waitForFunction((value) => document.getElementById('lang-target').value === value, TARGET)
      assert.equal(await settingsTarget.inputValue(), TARGET)
      await input.fill(INPUT)
      await page.locator('#btn-send').click()
      await page.locator('.entry:last-child .translation-text').getByText(PARAPHRASE, { exact: true }).waitFor()
      const workbench = received.get(INPUT)
      assert.equal(workbench.model, 'qwen3.8-flash')
      assert.match(workbench.messages[0].content, /Explain only selectedText in plain, natural English\./u)
      assert.equal(workbench.translation_options, undefined)
      await shot(page, 'main-english-explanation')

      await openPastedText(page, `${INPUT} It may come up again next year.`)
      await clickWord(page, WORD)
      await page.locator('#reading-lookup').getByRole('button', { name: 'Explain in English', exact: true }).waitFor()
      await page.locator('#reading-lookup-result').getByText(DEFINITION, { exact: true }).waitFor()
      const selection = received.get(WORD)
      assert.equal(selection.model, 'qwen3.8-flash')
      assert.match(selection.messages[0].content, /Explain only selectedText in plain, natural English\./u)
      const selectionInput = userInput(selection)
      assert.equal(selectionInput.targetLanguage, 'English')
      assert.equal(selectionInput.selectedOccurrence.before, 'The committee ')
      assert.match(selectionInput.selectedOccurrence.after, /^ the proposal\./u)

      await page.locator('#reading-sentence-explanation > summary').click()
      await page.locator('.reading-sentence-paraphrase').getByText(PARAPHRASE, { exact: true }).waitFor()
      const sentenceInput = userInput(received.get('sentence'))
      assert.equal(sentenceInput.targetLanguage, 'English')
      assert.equal(sentenceInput.selectedText, INPUT)
      await shot(page, 'main-article-english-explanation')
    } finally {
      mock.resetHandler()
      if (await page.locator('#settings-panel').isVisible()) await page.locator('#btn-close-settings').click()
      if (await page.locator('#reading-lookup').isVisible()) await page.locator('#reading-lookup-close').click()
      await page.locator('#btn-translate-workspace').click()
      await input.clear()
      await target.selectOption(originalTarget)
    }
  })

  await check('Single-word English explanation: switches the result without changing the default language', async () => {
    const word = 'deferred'
    const sentence = 'The committee deferred the vote.'
    const translation = '推迟'
    const definition = 'delayed until a later time'
    const paraphrase = '委员会推迟了投票。'
    const target = page.locator('#lang-target')
    const input = page.locator('#input')
    const entry = page.locator('.entry:last-child')
    const lookup = page.locator('#reading-lookup')
    const meaning = lookup.locator('#reading-lookup-meaning')
    const originalTarget = await target.inputValue()
    const received = []
    mock.setHandler(async ({ body, res, defaultResponse }) => {
      const data = userInput(body)
      if (![word, sentence].includes(data.selectedText)) return defaultResponse({ body, res })
      const analysis = isArticleExplanation(body)
      const english = body.messages[0].content.includes('Explain only selectedText in plain, natural English.')
      received.push({ data, analysis, english })
      reply(res, body, analysis ? { paraphrase } : { translation: english ? definition : translation, phonetic: '/dɪˈfɜrd/' })
    })
    try {
      await target.selectOption('auto')
      await input.fill(word)
      await page.locator('#btn-send').click()
      await entry.getByText(translation, { exact: true }).waitFor()
      await entry.getByRole('button', { name: 'Explain in English', exact: true }).click()
      await entry.getByText(definition, { exact: true }).waitFor()
      assert.equal(await target.inputValue(), 'auto')
      await entry.getByRole('button', { name: 'Translate', exact: true }).click()
      await entry.getByText(translation, { exact: true }).waitFor()

      await openPastedText(page, sentence)
      await clickWord(page, word)
      await meaning.getByText(translation, { exact: true }).waitFor()
      await lookup.locator('#reading-sentence-explanation > summary').click()
      await lookup.getByText(paraphrase, { exact: true }).waitFor()
      const english = lookup.getByRole('button', { name: 'Explain in English', exact: true })
      await english.click()
      await meaning.getByText(definition, { exact: true }).waitFor()
      assert.equal(await english.getAttribute('aria-pressed'), 'true')
      assert.equal(await lookup.getByText(paraphrase, { exact: true }).isVisible(), true)
      assert.equal(received.filter((item) => item.analysis).length, 1)
      const wordRequest = received.find((item) => item.english && item.data.selectedOccurrence)
      assert.equal(wordRequest.data.targetLanguage, 'English')
      assert.equal(wordRequest.data.selectedOccurrence.before, 'The committee ')
      assert.equal(wordRequest.data.selectedOccurrence.after, ' the vote.')
      await shot(page, 'main-article-single-word-english-explanation')
      await lookup.getByRole('button', { name: 'Translate', exact: true }).click()
      await meaning.getByText(translation, { exact: true }).waitFor()
      await selectText(page, 'deferred the vote')
      assert.equal(await english.isVisible(), false)
      assert.equal((await page.evaluate(() => chrome.storage.sync.get('desktop_target_language'))).desktop_target_language, 'auto')
    } finally {
      mock.resetHandler()
      if (await lookup.isVisible()) await page.locator('#reading-lookup-close').click()
      await page.locator('#btn-translate-workspace').click()
      await input.clear()
      await target.selectOption(originalTarget)
    }
  })
}
