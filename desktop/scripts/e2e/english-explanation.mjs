import assert from 'node:assert/strict'
import { isArticleExplanation } from './mock-api.mjs'
import { clickWord, openPastedText, selectText, withState } from './reading-lookup.mjs'

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
      await page.locator('#btn-clear-input').click()
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

      await withState(page, async () => {
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
        await meaning.locator('.translation-text').waitFor()
        await lookup.locator('#reading-sentence-structure[data-status="done"]').waitFor({ state: 'attached' })
        assert.equal(await english.isVisible(), false)
        assert.equal((await page.evaluate(() => chrome.storage.sync.get('desktop_target_language'))).desktop_target_language, 'auto')
      })
    } finally {
      mock.resetHandler()
      if (await lookup.isVisible()) await page.locator('#reading-lookup-close').click()
      await page.locator('#btn-translate-workspace').click()
      await page.locator('#btn-clear-input').click()
      await target.selectOption(originalTarget)
    }
  })

  await check('article word lookup mode: remembers Translate, Explain in English and Guided Reading', async () => {
    const sentence = 'The botanist catalogued orchids and wondered how they survived.'
    const phrase = 'how they survived'
    const wordModeKey = 'desktop_reading_word_lookup_mode'
    const lookup = page.locator('#reading-lookup')
    const meaning = lookup.locator('#reading-lookup-meaning')
    const translate = lookup.locator('#reading-lookup-translate')
    const explain = lookup.locator('#reading-lookup-explain')
    const guide = lookup.locator('#reading-lookup-guide')
    const target = page.locator('#lang-target')
    const originalTarget = await target.inputValue()
    const received = []
    const translation = (text) => `Translation of ${text}`
    const definition = (text) => `Definition of ${text}`
    const hint = (text) => `Think about the role of ${text}.`
    mock.setHandler(async ({ body, res, defaultResponse }) => {
      const input = userInput(body)
      if (!input.selectedOccurrence || isArticleExplanation(body)) return defaultResponse({ body, res })
      const text = input.selectedText
      const prompt = body.messages[0].content
      received.push(input)
      if (prompt.includes('You are a patient reading tutor.')) {
        reply(res, body, {
          guideType: 'term',
          hints: [hint(text), 'Think about what they noticed.', 'Think of a similar case in a garden.'],
          answer: { meaning: definition(text), explanation: hint(text), example: 'He sets aside a little time each day.' },
        })
      } else {
        const english = prompt.includes('Explain only selectedText in plain, natural English.')
        reply(res, body, { translation: english ? definition(text) : translation(text) })
      }
    })
    const waitForWordMode = (mode) => page.waitForFunction(async ({ key, value }) =>
      (await chrome.storage.sync.get(key))[key] === value, { key: wordModeKey, value: mode })
    const reopen = async () => {
      await page.reload()
      await openPastedText(page, sentence)
    }
    try {
      await withState(page, async () => {
        await page.evaluate(async (wordKey) => {
          await chrome.storage.sync.remove(wordKey)
          await chrome.storage.sync.set({ desktop_target_language: 'auto', desktop_reading_lookup_mode: 'guide' })
        }, wordModeKey)
        await reopen()
        await clickWord(page, 'catalogued')
        await meaning.getByText(translation('catalogued'), { exact: true }).waitFor()
        assert.equal(await translate.getAttribute('aria-pressed'), 'true', 'legacy phrase mode leaves first word lookup on Translate')

        await explain.click()
        await meaning.getByText(definition('catalogued'), { exact: true }).waitFor()
        await waitForWordMode(TARGET)
        await clickWord(page, 'orchids', 0, { keepOpen: true })
        await meaning.getByText(definition('orchids'), { exact: true }).waitFor()
        assert.equal(await explain.getAttribute('aria-pressed'), 'true')

        await selectText(page, phrase)
        await meaning.getByText(hint(phrase), { exact: true }).waitFor()
        assert.equal(await explain.isVisible(), false)
        await translate.click()
        await meaning.getByText(translation(phrase), { exact: true }).waitFor()
        assert.equal((await page.evaluate((key) => chrome.storage.sync.get(key), wordModeKey))[wordModeKey], TARGET)

        await lookup.locator('#reading-lookup-close').click()
        await page.locator('#btn-translate-workspace').click()
        assert.equal(await target.inputValue(), 'auto')
        await target.selectOption('Japanese')
        await page.waitForFunction(async () => (await chrome.storage.sync.get('desktop_target_language'))
          .desktop_target_language === 'Japanese')
        await reopen()
        await clickWord(page, 'wondered')
        await meaning.getByText(definition('wondered'), { exact: true }).waitFor()
        assert.equal(await explain.getAttribute('aria-pressed'), 'true')
        assert.equal(await target.inputValue(), 'Japanese')

        await guide.click()
        await meaning.getByText(hint('wondered'), { exact: true }).waitFor()
        await waitForWordMode('guide')
        await lookup.locator('[data-hint-more]').click()
        await lookup.locator('[data-guide-answer-toggle]').click()
        await meaning.locator('.answer').waitFor()
        const sentenceDetails = lookup.locator('#reading-sentence-explanation')
        await sentenceDetails.locator(':scope > summary').click()
        await translate.click()
        await meaning.getByText(translation('wondered'), { exact: true }).waitFor()
        assert.equal(await sentenceDetails.evaluate((details) => details.open), false)
        await guide.click()
        await meaning.locator('.answer').waitFor()
        await meaning.getByText('Think about what they noticed.', { exact: true }).waitFor()
        assert.equal(await sentenceDetails.evaluate((details) => details.open), true)
        await waitForWordMode('guide')
        await clickWord(page, 'survived')
        await meaning.getByText(hint('survived'), { exact: true }).waitFor()
        assert.equal(await meaning.locator('.answer').count(), 0)
        await reopen()
        await clickWord(page, 'orchids')
        await meaning.getByText(hint('orchids'), { exact: true }).waitFor()
        assert.equal(await guide.getAttribute('aria-pressed'), 'true')

        await translate.click()
        await meaning.getByText(translation('orchids'), { exact: true }).waitFor()
        await waitForWordMode('translate')
        await clickWord(page, 'wondered')
        await meaning.getByText(translation('wondered'), { exact: true }).waitFor()
        await reopen()
        await clickWord(page, 'survived')
        await meaning.getByText(translation('survived'), { exact: true }).waitFor()
        await lookup.locator('#reading-sentence-structure[data-status="done"]').waitFor({ state: 'attached' })
        assert.equal(await translate.getAttribute('aria-pressed'), 'true')
        assert.equal(received.at(-1).targetLanguage, 'Japanese')
      })
    } finally {
      mock.resetHandler()
      await target.selectOption(originalTarget)
    }
  })
}
