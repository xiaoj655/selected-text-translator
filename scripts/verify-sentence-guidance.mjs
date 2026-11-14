import assert from 'node:assert/strict'
import { join } from 'node:path'

export const SENTENCE_GUIDANCE_FIXTURES = [
  {
    id: 'complex-sentence',
    text: 'Although the train was late, we still arrived before the meeting began.',
    translation: '虽然火车晚点了，我们仍在会议开始前到达。',
    guide: {
      guideType: 'sentence',
      phonetic: '',
      hints: [
        'Follow two parts: the train was late, then notice what happened to the travellers.',
        'Although introduces a problem. Still tells you that the result was better than expected.',
      ],
      answer: {
        meaning: 'The train was delayed, but we got to the meeting before it started.',
        explanation: 'Although introduces the delay. Still marks the unexpected result: arriving before the meeting began.',
        example: '',
      },
    },
  },
  {
    id: 'short-sentence',
    text: 'I wish I had more time',
    translation: '我希望自己有更多时间。',
    guide: {
      guideType: 'sentence',
      phonetic: '',
      hints: ["After 'wish', 'had' describes a different present situation, rather than an event in the past."],
      answer: {
        meaning: 'I want more time than I have now.',
        explanation: 'I wish plus had describes a present situation that the speaker wants to change.',
        example: '',
      },
    },
  },
]

async function waitForCardFocus(page, selector) {
  await page.waitForFunction((selector) => {
    const root = document.getElementById('selected-reading-assistant').shadowRoot
    return Boolean(root.activeElement?.matches(selector))
  }, selector)
}

async function assertSentenceCard(page, fixture, { isRevealed = false, hintCount = 1 } = {}) {
  assert.equal(await page.locator('.stt-guide-heading .stt-section-label').textContent(), 'FOLLOW THE SENTENCE')
  assert.equal(await page.locator('.stt-hint').count(), hintCount)
  assert.equal(await page.locator('.stt-hint p').first().textContent(), fixture.guide.hints[0])
  assert.equal(await page.locator('.stt-answer').count(), isRevealed ? 1 : 0)
  assert.equal(await page.locator('.stt-example, .stt-usage, .stt-phonetic').count(), 0)
  assert.equal(await page.getByRole('button', { name: '查看音标', exact: true }).count(), 0)
  assert.doesNotMatch(await page.locator('.stt-card').textContent(), /ANOTHER WAY TO USE IT/)
  if (isRevealed) {
    assert.equal(await page.locator('.stt-meaning').textContent(), fixture.guide.answer.meaning)
    assert.equal(await page.locator('.stt-sentence-explanation > summary').textContent(), '为什么这样理解')
    assert.equal(await page.locator('.stt-sentence-explanation .stt-explanation').textContent(),
      fixture.guide.answer.explanation)
    return
  }
  assert.equal(await page.locator('.stt-reveal').textContent(), '看简单表达')
  assert.equal(await page.locator('.stt-sentence-explanation').count(), 0)
  assert.equal((await page.locator('.stt-card').textContent()).includes(fixture.guide.answer.meaning), false)
}

async function verifyHiddenModeSwitch(page, fixture, requests) {
  const callsBeforeTranslate = requests.length
  await page.getByRole('button', { name: '翻译', exact: true }).focus()
  await page.keyboard.press('Enter')
  await page.locator('.stt-card-block--translation').waitFor()
  assert.equal(await page.locator('.stt-card-block--translation').textContent(), fixture.translation)
  assert.equal(await page.locator('.stt-answer, .stt-meaning, .stt-sentence-explanation').count(), 0)
  assert.equal((await page.locator('.stt-card').textContent()).includes(fixture.guide.answer.meaning), false)
  assert.equal(await page.locator('.stt-phonetic').count(), 0)
  assert.equal(requests.length, callsBeforeTranslate + 1)
  await page.getByRole('button', { name: '引导理解', exact: true }).focus()
  await page.keyboard.press('Enter')
  await page.locator('.stt-hint').waitFor()
  await waitForCardFocus(page, '.stt-tab[aria-pressed="true"]')
  await assertSentenceCard(page, fixture)
  await page.getByRole('button', { name: '翻译', exact: true }).click()
  await page.locator('.stt-card-block--translation').waitFor()
  await page.getByRole('button', { name: '引导理解', exact: true }).click()
  await assertSentenceCard(page, fixture)
  assert.equal(requests.length, callsBeforeTranslate + 1)
}

async function revealAndInspectExplanation(page, fixture, requests) {
  const callsBeforeReveal = requests.length
  await page.locator('.stt-next-hint').focus()
  await page.keyboard.press('Tab')
  await waitForCardFocus(page, '.stt-reveal')
  await page.keyboard.press('Enter')
  await waitForCardFocus(page, '.stt-answer')
  await assertSentenceCard(page, fixture, { isRevealed: true })
  assert.equal(await page.locator('.stt-sentence-explanation').getAttribute('open'), null)
  assert.equal(await page.locator('.stt-sentence-explanation .stt-explanation').isVisible(), false)
  await page.keyboard.press('Tab')
  await waitForCardFocus(page, '.stt-sentence-explanation > summary')
  await page.keyboard.press('Enter')
  await page.locator('.stt-sentence-explanation[open]').waitFor()
  await waitForCardFocus(page, '.stt-sentence-explanation > summary')
  assert.equal(await page.locator('.stt-sentence-explanation .stt-explanation').isVisible(), true)
  assert.equal(requests.length, callsBeforeReveal)
}

async function saveSentence(page, worker, fixture) {
  await page.keyboard.press('Tab')
  await waitForCardFocus(page, '.stt-save')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: '✓ 已收藏', exact: true }).waitFor()
  await waitForCardFocus(page, '.stt-save')
  assert.equal(await page.locator('.stt-sentence-explanation').getAttribute('open'), '')
  const saved = await worker.evaluate(async (text) => {
    const entries = (await chrome.storage.local.get('vocabulary_entries')).vocabulary_entries
    return entries.find((entry) => entry.text === text)
  }, fixture.text)
  assert.equal(saved.meaning, fixture.guide.answer.meaning)
  assert.equal(saved.explanation, fixture.guide.answer.explanation)
  assert.equal(saved.example, '')
  assert.equal(saved.phonetic, '')
  assert.equal(saved.usage, '')
}

async function regenerateSentence(page, fixture, requests, holdGuideResponse) {
  const callsBeforeRefresh = requests.length
  const refresh = holdGuideResponse()
  await page.locator('.stt-regenerate').focus()
  await page.keyboard.press('Enter')
  await page.locator('.stt-refresh-status').waitFor()
  await refresh.started
  assert.equal(await page.locator('.stt-answer').count(), 1)
  assert.equal(await page.locator('.stt-sentence-explanation').getAttribute('open'), '')
  refresh.release()
  await page.locator('.stt-refresh-status').waitFor({ state: 'detached' })
  await waitForCardFocus(page, '.stt-regenerate')
  await assertSentenceCard(page, fixture)
  assert.equal(requests.length, callsBeforeRefresh + 1)
  await page.locator('.stt-next-hint').focus()
  await page.keyboard.press('Enter')
  await waitForCardFocus(page, '.stt-reveal')
  await assertSentenceCard(page, fixture, { hintCount: 2 })
  assert.equal(await page.locator('.stt-next-hint').count(), 0)
  await page.keyboard.press('Enter')
  await waitForCardFocus(page, '.stt-answer')
  await assertSentenceCard(page, fixture, { isRevealed: true, hintCount: 2 })
  assert.equal(await page.locator('.stt-sentence-explanation').getAttribute('open'), null)
  assert.equal(requests.length, callsBeforeRefresh + 1)
}

export async function verifySentenceGuidance({
  worker, context, origin, selectText, requests, errors, holdGuideResponse, artifactPath,
}) {
  await worker.evaluate(async () => {
    await chrome.storage.sync.set({ model: 'test-generic', reading_mode: 'guide' })
  })
  const sentencePage = await context.newPage()
  sentencePage.on('pageerror', (error) => errors.push(error.message))
  await sentencePage.goto(`${origin}/sentence-guidance`)
  await sentencePage.locator('#selected-reading-assistant').waitFor({ state: 'attached' })
  const [complex, short] = SENTENCE_GUIDANCE_FIXTURES
  const callsBeforeOpen = requests.length
  await selectText(complex.text, `#${complex.id}`, 0, sentencePage)
  await sentencePage.locator('.stt-trigger').focus()
  await sentencePage.keyboard.press('Enter')
  await sentencePage.locator('.stt-hint').waitFor()
  await assertSentenceCard(sentencePage, complex)
  assert.equal(await sentencePage.locator('.stt-next-hint').textContent(), '再拆一点 →')
  assert.equal(requests.length, callsBeforeOpen + 1)
  await sentencePage.locator('.stt-card').screenshot({ path: join(artifactPath, 'sentence-card.png') })
  await verifyHiddenModeSwitch(sentencePage, complex, requests)
  await revealAndInspectExplanation(sentencePage, complex, requests)
  const callsBeforeSave = requests.length
  await saveSentence(sentencePage, worker, complex)
  assert.equal(requests.length, callsBeforeSave)
  await sentencePage.locator('.stt-card').screenshot({ path: join(artifactPath, 'sentence-answer.png') })
  await regenerateSentence(sentencePage, complex, requests, holdGuideResponse)
  const callsBeforeShort = requests.length
  await selectText(short.text, `#${short.id}`, 0, sentencePage)
  await sentencePage.locator('.stt-trigger').click()
  await sentencePage.locator('.stt-hint').waitFor()
  await assertSentenceCard(sentencePage, short)
  assert.equal(JSON.parse(requests.at(-1).messages[1].content).selectionType, 'phrase')
  assert.equal(await sentencePage.locator('.stt-next-hint').count(), 0)
  assert.equal(requests.length, callsBeforeShort + 1)
  await sentencePage.locator('.stt-reveal').focus()
  await sentencePage.keyboard.press('Enter')
  await waitForCardFocus(sentencePage, '.stt-answer')
  await assertSentenceCard(sentencePage, short, { isRevealed: true })
  assert.equal(await sentencePage.locator('.stt-sentence-explanation').getAttribute('open'), null)
  assert.equal(requests.length, callsBeforeShort + 1)
  await sentencePage.close()
}
