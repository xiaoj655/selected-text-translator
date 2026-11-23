import assert from 'node:assert/strict'
import { withSpeechCommands } from './cloud-speech.mjs'
import { isArticleExplanation } from './mock-api.mjs'

const PASSAGE = 'We will record the interview, then keep a record for the team. The editor’s well-known method helps engineers put off a risky release.'
const SENTENCE = 'We will record the interview, then keep a record for the team.'
const RACE_PASSAGE = 'The orchard stands beside the harbor. A meadow lies beyond the canyon, close to the riverside.'
const LONG_PASSAGE = 'A record keeps earlier decisions available. '
  + 'Background information gives readers more detail about the project. '.repeat(55)
  + '\n\nWe will record a new interview at the end of this article.'
const DRAG_SENTENCE = 'The editor’s well-known method for gradually moving the release back until the testing team is ready helps engineers avoid mistakes.'
const LAYERED_SELECTION = "There are some kinds of work that you can't do well without thinking differently from your peers. To be a successful scientist"
const MODE_KEY = 'desktop_reading_lookup_mode'

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function until(predicate, label) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > 6000) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function sourceData(body) {
  try {
    const data = JSON.parse(body.messages.at(-1).content)
    return data?.selectedText ? data : null
  } catch {
    return null
  }
}

function reply(res, content) {
  if (res.destroyed) return
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }))
}

function translation(data) {
  if (data.selectedText === 'record') return data.selectedOccurrence.before.endsWith('will ') ? '录制采访' : '一份记录'
  return `Meaning of ${data.selectedText}`
}

function guide(data) {
  const sentence = data.selectedText === SENTENCE
  return {
    guideType: sentence ? 'sentence' : 'term',
    hints: sentence
      ? ['“We will record” gives the main action.', '“then” puts the second action after the first.']
      : ['Notice the action near this expression.', 'Look at what happens to the release.', 'Think of moving a plan to a later day.'],
    ...(sentence && { structure: [
      { role: 'subject', text: 'We' }, { role: 'verb', text: 'will record' }, { role: 'object', text: 'the interview' },
      { role: 'verb', text: 'keep' }, { role: 'object', text: 'a record' },
    ] }),
    answer: sentence
      ? { meaning: 'We will save the interview and keep a copy for our team.', explanation: 'The two uses of record describe an action and its result.' }
      : { meaning: 'to delay a planned action', explanation: 'The release will happen later.', example: 'We put off the meeting until Monday.', usage: 'put off + activity' },
  }
}

export async function openPastedText(page, text) {
  await page.locator('#btn-tutor-workspace').click()
  await page.locator('#tutor-reading-mode').click()
  if (await page.locator('#reading-back').isVisible()) await page.locator('#reading-back').click()
  await page.locator('#reading-paste').click()
  await page.locator('#reading-paste-text').fill(text)
  await page.locator('#reading-paste-open').click()
  await page.locator('.reading-preview').first().waitFor()
  // History can restore an existing article's position on the next frame.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

// Return a real text range's rectangle, even if the renderer later wraps tokens.
async function textRange(page, text, occurrence = 0, select = false) {
  return page.evaluate(async ({ text, occurrence, select }) => {
    const host = [...document.querySelectorAll('.reading-preview')]
      .find((node) => node.getClientRects().length && node.textContent.split(text).length > occurrence + 1)
    if (!host) throw new Error(`Missing visible article text: ${text}`)
    let start = -1
    for (let index = 0; index <= occurrence; index++) start = host.textContent.indexOf(text, start + 1)
    if (start < 0) throw new Error(`Missing occurrence ${occurrence}: ${text}`)
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    let offset = 0
    let node
    let hasStart = false
    while ((node = walker.nextNode())) {
      const end = offset + node.textContent.length
      if (!hasStart && start < end) {
        range.setStart(node, start - offset)
        hasStart = true
      }
      if (hasStart && start + text.length <= end) {
        range.setEnd(node, start + text.length - offset)
        break
      }
      offset = end
    }
    let bounds = range.getClientRects()[0]
    if (!bounds) throw new Error(`Article range has no rectangle: ${text}`)
    if (bounds.top < 80 || bounds.bottom > innerHeight - 30) {
      document.getElementById('tutor-workspace').scrollBy(0, bounds.top - innerHeight / 2)
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      bounds = range.getClientRects()[0]
    }
    if (select) {
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      host.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true, button: 0, clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2,
      }))
    }
    return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }
  }, { text, occurrence, select })
}

export async function clickWord(page, word, occurrence = 0, { keepOpen = false } = {}) {
  if (!keepOpen && await page.locator('#reading-lookup').isVisible()) await page.locator('#reading-lookup-close').click()
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  const point = await textRange(page, word, occurrence)
  await page.mouse.click(point.x, point.y)
  await page.locator('#reading-lookup').waitFor({ state: 'visible' })
  assert.equal(await page.locator('#reading-lookup-text').textContent(), word)
}

export async function selectText(page, text, occurrence = 0, { keepOpen = false } = {}) {
  if (!keepOpen && await page.locator('#reading-lookup').isVisible()) await page.locator('#reading-lookup-close').click()
  await textRange(page, text, occurrence, true)
  await page.locator('#reading-lookup').waitFor({ state: 'visible' })
  assert.equal(await page.locator('#reading-lookup-text').textContent(), text)
}

export async function withState(page, run) {
  const snapshot = await page.evaluate(async () => ({
    sync: await chrome.storage.sync.get(['model', 'learning_model', 'desktop_live_translate', 'desktop_prefs', 'desktop_reading_lookup_mode']),
    local: await chrome.storage.local.get(['vocabulary_entries', 'desktop_tutor_v1']),
    live: document.getElementById('opt-live-translate').checked,
    theme: document.getElementById('opt-theme').value,
  }))
  await page.evaluate(async () => {
    await chrome.storage.sync.set({ model: 'mock-generic', learning_model: 'mock-generic' })
    const live = document.getElementById('opt-live-translate')
    live.checked = false
    live.dispatchEvent(new Event('change', { bubbles: true }))
    await chrome.storage.local.set({ vocabulary_entries: [], desktop_tutor_v1: [] })
  })
  try {
    await run()
  } finally {
    if (await page.locator('#reading-lookup').isVisible()) {
      // Set the module's session preference as well as restoring stored settings.
      await page.locator('#reading-lookup-translate').click()
      await page.locator('#reading-lookup-close').click()
    }
    await page.locator('#btn-translate-workspace').click()
    await page.evaluate(async ({ sync, local, live, theme }) => {
      const liveControl = document.getElementById('opt-live-translate')
      liveControl.checked = live
      liveControl.dispatchEvent(new Event('change', { bubbles: true }))
      const themeControl = document.getElementById('opt-theme')
      themeControl.value = theme
      themeControl.dispatchEvent(new Event('change', { bubbles: true }))
      await chrome.storage.sync.remove(['model', 'learning_model', 'desktop_live_translate', 'desktop_prefs', 'desktop_reading_lookup_mode'].filter((key) => !Object.hasOwn(sync, key)))
      await chrome.storage.local.remove(['vocabulary_entries', 'desktop_tutor_v1'].filter((key) => !Object.hasOwn(local, key)))
      await chrome.storage.sync.set(sync)
      await chrome.storage.local.set(local)
    }, snapshot)
  }
}

export async function verifyReadingLookup({ app, page, mock, check, shot, readingFeeds }) {
  await check('guided shortcuts: article works from the selection and pauses when minimized', async () => {
    const inputs = []
    mock.setHandler(async ({ body, res, defaultResponse }) => {
      const data = sourceData(body)
      if (!data || isArticleExplanation(body)) return defaultResponse({ body, res })
      const isGuide = body.messages[0].content.includes('You are a patient reading tutor.')
      if (isGuide) inputs.push(data.selectedText)
      reply(res, isGuide ? guide(data) : { translation: translation(data) })
    })
    const hints = page.locator('#reading-lookup-result .hint-text')
    try {
      await withState(page, async () => {
        await withSpeechCommands(page, async (commands) => {
          await openPastedText(page, PASSAGE)
          await selectText(page, 'put off')
          await page.locator('#reading-lookup-guide').click()
          await hints.first().waitFor()
          await page.keyboard.press('Space')
          assert.equal(await hints.count(), 2)
          await page.keyboard.press('r')
          const [speak] = await commands()
          assert.equal(speak.type, 'SPEAK_TEXT')
          assert.equal(speak.payload.text, 'put off')
          await page.keyboard.press('r')
          assert.deepEqual((await commands()).at(-1), { type: 'STOP_SPEECH', payload: { speechId: speak.payload.speechId } })

          await page.locator('#reading-lookup-minimize').click()
          await page.keyboard.press('r')
          assert.equal((await commands()).length, 2)
          await page.locator('#reading-lookup-reopen').click()
          assert.equal(await hints.count(), 2)

          await clickWord(page, 'engineers')
          await page.locator('#reading-lookup-result .translation-text').waitFor()
          await page.locator('#reading-lookup-guide').click()
          await hints.first().waitFor()
          await page.keyboard.press('Space')
          assert.equal(await hints.count(), 2)
          assert.deepEqual(inputs, ['put off', 'engineers'])
          assert.equal(await page.locator('#reading-lookup-result .answer').count(), 0)
        })
      })
    } finally {
      mock.resetHandler()
    }
  })

  await check('direct shortcuts: article opens dictionary then previously folded grammar and toggles source speech', async () => {
    mock.setHandler(async ({ body, res, defaultResponse }) => {
      const data = sourceData(body)
      if (!data) return defaultResponse({ body, res })
      if (isArticleExplanation(body)) return reply(res, {
        paraphrase: 'The team will save a copy of the interview.', structure: guide(data).structure,
      })
      reply(res, {
        translation: translation(data), phonetic: '/rɪˈkɔːrd/',
        definitions: [{ pos: 'v.', meaning: 'to save sound for later' }],
      })
    })
    try {
      await withState(page, async () => {
        await withSpeechCommands(page, async (commands) => {
          await openPastedText(page, PASSAGE)
          await clickWord(page, 'record')
          const panel = page.locator('#reading-lookup')
          const dictionary = panel.locator('.lexical-details')
          const grammar = panel.locator('#reading-sentence-toggle')
          await dictionary.waitFor()
          await grammar.waitFor()
          assert.equal(await grammar.getAttribute('open'), '')
          await grammar.locator(':scope > summary').click()
          await page.waitForFunction(() => !CSS.highlights.has('reading-lookup-verb'))
          await panel.focus()
          await page.keyboard.press('Space')
          assert.equal(await dictionary.getAttribute('open'), '')
          assert.equal(await grammar.getAttribute('open'), null)
          await page.keyboard.press('Space')
          await grammar.locator('.sentence-legend').waitFor()
          assert.equal(await grammar.getAttribute('open'), '')
          await page.waitForFunction(() => CSS.highlights.has('reading-lookup-verb'))
          assert.equal(await panel.evaluate((node) => node.dispatchEvent(new KeyboardEvent('keydown', {
            key: ' ', cancelable: true, bubbles: true,
          }))), true, 'Space remains available for scrolling once all details are open')

          await page.keyboard.press('r')
          const [speech] = await commands()
          assert.equal(speech.type, 'SPEAK_TEXT')
          assert.equal(speech.payload.text, 'record')
          await page.keyboard.press('r')
          assert.deepEqual((await commands()).at(-1), { type: 'STOP_SPEECH', payload: { speechId: speech.payload.speechId } })
        })
      })
    } finally { mock.resetHandler() }
  })

  await check('article lookup: backward cross-line word snap and persistent sentence lookup', async () => {
    const inputs = []
    const sentenceResponse = deferred()
    let previousBounds
    mock.setHandler(async ({ body, res, defaultResponse }) => {
      const data = sourceData(body)
      if (!data || isArticleExplanation(body)) return defaultResponse({ body, res })
      inputs.push(data)
      if (data.selectedText === DRAG_SENTENCE) await sentenceResponse.promise
      reply(res, { translation: `Meaning of ${data.selectedText}` })
    })
    try {
      await withState(page, async () => {
        await openPastedText(page, `${DRAG_SENTENCE}\n\n${LONG_PASSAGE}`)
        previousBounds = await app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('index.html'))
          const bounds = win.getBounds()
          win.setContentSize(620, 520)
          return bounds
        })
        await page.waitForFunction(() => innerWidth === 620 && innerHeight === 520)

        const firstWord = await textRange(page, 'well-known')
        const lastWord = await textRange(page, 'helps')
        assert.ok(lastWord.y > firstWord.y, 'the drag must cross two lines')
        await page.mouse.move(lastWord.x, lastWord.y)
        await page.mouse.down()
        await page.mouse.move(firstWord.x, firstWord.y, { steps: 8 })
        assert.equal(inputs.length, 0, 'dragging does not ask the model before release')
        await page.mouse.up()
        const snapped = 'well-known method for gradually moving the release back until the testing team is ready helps'
        await page.waitForFunction((text) => document.querySelector('#reading-lookup-text')?.textContent === text, snapped)
        await until(() => inputs.length === 1, 'the snapped lookup request')
        assert.equal(inputs[0].selectedText, snapped)
        assert.equal(inputs[0].surroundingContext.slice(inputs[0].contextStart, inputs[0].contextEnd), snapped)
        await page.locator('#reading-lookup-close').click()

        const point = await textRange(page, 'engineers')
        const articlePosition = point.y
        await page.mouse.move(point.x, point.y)
        await page.getByRole('button', { name: 'Look up sentence' }).click()
        await until(() => inputs.length === 2, 'the sentence lookup request')
        assert.equal(inputs[1].selectedText, DRAG_SENTENCE)
        assert.ok(Math.abs((await textRange(page, 'engineers')).y - articlePosition) < 36,
          'opening the short translation should keep the original sentence near its previous position')

        const afterScroll = await page.locator('#tutor-workspace').evaluate((node) => {
          const before = node.scrollTop
          node.scrollTop += 475
          return node.scrollTop - before
        })
        assert.ok(afterScroll > 0, 'the reading viewport must actually scroll while waiting for the sentence')
        sentenceResponse.resolve()
        await page.waitForFunction(() => document.querySelector('#reading-lookup-result .translation-text')?.textContent.startsWith('Meaning of'))
        assert.equal(await page.locator('#reading-lookup-text').textContent(), DRAG_SENTENCE)
        await page.locator('#tutor-workspace').evaluate((node) => {
          const panel = document.getElementById('reading-lookup')
          node.scrollTop += Math.max(0, panel.getBoundingClientRect().bottom - node.getBoundingClientRect().top + 24)
        })
        await page.locator('#reading-lookup-reopen').click()
        assert.equal(await page.locator('#reading-lookup').getAttribute('data-placement'), 'inline')
        const geometry = await page.evaluate(() => ({
          viewport: document.querySelector('#tutor-workspace').getBoundingClientRect().top,
          source: [...CSS.highlights.get('reading-lookup-selection')][0].getBoundingClientRect().toJSON(),
          result: document.querySelector('#reading-lookup').getBoundingClientRect().toJSON(),
        }))
        assert.ok(geometry.source.top >= geometry.viewport, 'reopening inline should return to the sentence')
        assert.ok(geometry.result.top >= geometry.source.bottom - 1, 'the inline result should not cover source text')
        await shot?.(page, 'main-article-lookup-inline')
        await page.locator('#reading-lookup-expand').click()
        await page.locator('#reading-lookup[data-placement="bottom"]').waitFor()
        await page.locator('#reading-lookup-minimize').click()
        await page.locator('#reading-lookup-reopen').click()
        await page.locator('#reading-lookup[data-placement="bottom"]').waitFor()
        assert.equal(inputs.filter(({ selectedText }) => selectedText === DRAG_SENTENCE).length, 1)
      })
    } finally {
      sentenceResponse.resolve()
      if (previousBounds) await app.evaluate(({ BrowserWindow }, bounds) => {
        BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('index.html')).setBounds(bounds)
      }, previousBounds)
      mock.resetHandler()
    }
  })

  await check('article lookup: exact word context, native selection, both modes and saved source', async () => {
    const inputs = []
    mock.setHandler(async ({ body, res, defaultResponse }) => {
      const data = sourceData(body)
      if (!data) return defaultResponse({ body, res })
      if (isArticleExplanation(body)) return reply(res, {
        paraphrase: 'The sentence explains what happened.', structure: guide(data).structure || [],
      })
      const isGuide = body.messages[0].content.includes('You are a patient reading tutor.')
      inputs.push({ data, isGuide })
      reply(res, isGuide ? guide(data) : { translation: translation(data) })
    })
    try {
      await withState(page, async () => {
        await openPastedText(page, PASSAGE)
        await clickWord(page, 'record')
        await page.locator('#reading-lookup-result').getByText('录制采访', { exact: true }).waitFor()
        assert.equal(inputs[0].data.selectedOccurrence.before.endsWith('will '), true)
        assert.equal(inputs[0].data.surroundingContext.slice(inputs[0].data.contextStart, inputs[0].data.contextEnd), 'record')
        await clickWord(page, 'record', 1)
        await page.locator('#reading-lookup-result').getByText('一份记录', { exact: true }).waitFor()
        assert.equal(inputs[1].data.selectedOccurrence.before.endsWith('a '), true)
        assert.notEqual(inputs[0].data.contextStart, inputs[1].data.contextStart)
        await page.locator('#reading-lookup-copy').click()
        assert.equal(await page.evaluate(() => window.sttDesktop.readClipboard()), '一份记录')
        for (const word of ['editor’s', 'well-known']) {
          await clickWord(page, word)
          await page.locator('#reading-lookup-result').getByText(`Meaning of ${word}`, { exact: true }).waitFor()
          assert.equal(inputs.at(-1).data.selectedText, word)
        }

        const beforeSelection = inputs.length
        await selectText(page, 'put off')
        await page.locator('#reading-lookup-result').getByText('Meaning of put off', { exact: true }).waitFor()
        assert.equal(inputs.length, beforeSelection + 1, 'native selection should start one lookup using the current mode')
        assert.equal(inputs.at(-1).isGuide, false)
        await page.locator('#reading-lookup-guide').click()
        await page.locator('#reading-lookup-result .hint').first().waitFor()
        assert.equal(await page.locator('#reading-lookup-result .hint').count(), 1)
        assert.equal(await page.locator('#reading-lookup-result .answer').count(), 0)
        await page.locator('#reading-lookup-result').getByRole('button', { name: /Next hint/u }).click()
        assert.equal(await page.locator('#reading-lookup-result .hint').count(), 2)
        await page.locator('#reading-lookup-result').getByRole('button', { name: 'Reveal answer', exact: true }).click()
        await page.locator('#reading-lookup-result .answer').getByText('to delay a planned action', { exact: false }).waitFor()
        await page.waitForFunction(async () => {
          const saved = await chrome.storage.local.get('desktop_tutor_v1')
          return saved.desktop_tutor_v1?.some((item) => item.text === 'put off')
        })
        const sources = await page.evaluate(async () => (await chrome.storage.local.get('desktop_tutor_v1')).desktop_tutor_v1)
        assert.equal(sources.filter((item) => item.text === 'put off').length, 1)
        assert.equal(sources.some((item) => item.text === 'record'), false, 'single words must not become Review exercises')
        await clickWord(page, 'engineers')
        await page.locator('#reading-lookup-result').getByText('Meaning of engineers', { exact: true }).waitFor()
        assert.equal(inputs.at(-1).data.selectedText, 'engineers')
        assert.equal(inputs.at(-1).isGuide, false)
        await selectText(page, SENTENCE)
        await page.locator('#reading-lookup-result .hint').first().waitFor()
        await page.locator('#reading-lookup-result').getByRole('button', { name: /Next hint/u }).click()
        await page.locator('#reading-lookup-result').getByText('“then” puts the second action after the first.', { exact: true }).waitFor()
        assert.equal(inputs.at(-1).isGuide, true)
        assert.equal(inputs.at(-1).data.selectedText, SENTENCE)
        await page.locator('#reading-sentence-structure[data-status="done"]').waitFor({ state: 'attached' })
        const explanation = page.locator('#reading-sentence-explanation')
        assert.equal(await explanation.getAttribute('open'), null)
        assert.equal(await explanation.locator('.reading-sentence-paraphrase').isVisible(), false)
        await page.waitForFunction(() => CSS.highlights.has('reading-lookup-verb'))
        const articleHighlights = () => page.evaluate(() => Object.fromEntries(
          ['selection', 'subject', 'verb', 'object', 'complement'].flatMap((role) => {
            const ranges = CSS.highlights.get(`reading-lookup-${role}`)
            return ranges ? [[role, [...ranges].map((range) => range.toString())]] : []
          }),
        ))
        assert.deepEqual(await articleHighlights(), { subject: ['We'], verb: ['will record', 'keep'], object: ['the interview', 'a record'] })
        const legend = page.locator('#reading-lookup-result .sentence-legend')
        await explanation.locator(':scope > summary').click()
        await legend.waitFor()
        assert.deepEqual(await legend.locator('li').allTextContents(), ['Subject', 'Verb', 'Object'])
        await shot?.(page, 'main-article-sentence-structure')
        await page.locator('#reading-lookup-translate').click()
        await page.locator('#reading-lookup-result').getByText(`Meaning of ${SENTENCE}`, { exact: true }).waitFor()
        await legend.waitFor()
        assert.deepEqual(await articleHighlights(), { subject: ['We'], verb: ['will record', 'keep'], object: ['the interview', 'a record'] })
        await page.locator('#reading-lookup-guide').click()
        assert.equal(await explanation.getAttribute('open'), null)
        await explanation.locator(':scope > summary').click()
        await legend.waitFor()

        await page.locator('#reading-lookup-close').click()
        assert.deepEqual(await articleHighlights(), {})
        await page.locator('#reading-back').click()
        await page.locator('#reading-category-news').click()
        await page.locator('#reading-articles').getByRole('button', { name: readingFeeds.news.title, exact: false }).first().click()
        await clickWord(page, 'refining')
        await page.locator('#reading-lookup-translate').click()
        await page.locator('#reading-lookup-result').getByText('Meaning of refining', { exact: true }).waitFor()
        await page.locator('#reading-lookup-save').click()
        await page.waitForFunction(async () => {
          const saved = await chrome.storage.local.get('vocabulary_entries')
          return saved.vocabulary_entries?.some((item) => item.text === 'refining')
        })
        const saved = await page.evaluate(async () => (await chrome.storage.local.get('vocabulary_entries')).vocabulary_entries.find((item) => item.text === 'refining'))
        assert.equal(saved.sourceUrl, readingFeeds.news.url)
        assert.ok(saved.context.includes('A shortage of refining capacity'))
        assert.equal(saved.context.slice(saved.contextStart, saved.contextEnd), 'refining')
        await shot?.(page, 'main-article-lookup')

        await openPastedText(page, PASSAGE)
        const beforeDoubleClick = inputs.length
        const point = await textRange(page, 'release')
        await page.mouse.dblclick(point.x, point.y, { delay: 50 })
        await page.locator('#reading-lookup-result').getByText('Meaning of release', { exact: true }).waitFor()
        assert.equal(await page.evaluate(() => window.getSelection().toString()), 'release')
        assert.equal(inputs.length, beforeDoubleClick + 1, 'double-click selection should start only one lookup')

        const earlierSelection = 'The editor’s well-known method'
        await selectText(page, earlierSelection)
        await page.locator('#reading-lookup-result').getByText(`Meaning of ${earlierSelection}`, { exact: true }).waitFor()
        await page.locator('#reading-lookup-close').click()
        assert.equal(await page.evaluate(() => window.getSelection().toString()), earlierSelection)
        const material = page.locator('.reading-preview:visible').first()
        await material.dispatchEvent('keydown', { key: 'Shift' })
        await material.dispatchEvent('keyup', { key: 'Shift' })
        assert.equal(await page.locator('#reading-lookup').isVisible(), false)
        const nextWord = await textRange(page, 'method')
        await page.mouse.click(nextWord.x, nextWord.y)
        await page.locator('#reading-lookup-result').getByText('Meaning of method', { exact: true }).waitFor()
        assert.equal(await page.locator('#reading-lookup-text').textContent(), 'method')

        await openPastedText(page, LONG_PASSAGE)
        await clickWord(page, 'record', 1)
        await page.locator('#reading-lookup-result').getByText('录制采访', { exact: true }).waitFor()
        const tail = inputs.at(-1).data
        assert.ok(LONG_PASSAGE.lastIndexOf('record') > 2400, 'the selected occurrence must be beyond the first context window')
        assert.ok(tail.surroundingContext.length <= 2400)
        assert.ok(tail.surroundingContext.includes('at the end of this article'))
        assert.equal(tail.surroundingContext.slice(tail.contextStart, tail.contextEnd), 'record')
        assert.equal(tail.selectedOccurrence.before.endsWith('will '), true)
        assert.equal(await page.evaluate((key) => chrome.storage.sync.get(key).then((values) => values[key]), MODE_KEY), 'translate')

        await page.locator('#reading-lookup-guide').click()
        await page.waitForFunction(async (key) => (await chrome.storage.sync.get(key))[key] === 'guide', MODE_KEY)
        await page.reload()
        await openPastedText(page, PASSAGE)
        await selectText(page, 'a risky release')
        await page.locator('#reading-lookup-result .hint').first().waitFor()
        assert.equal(inputs.at(-1).data.selectedText, 'a risky release')
        assert.equal(inputs.at(-1).isGuide, true, 'first lookup after reload should use the saved mode')
      })
    } finally {
      mock.resetHandler()
    }
  })

  await check('article lookup: partial final sentence is completed and both sentences keep their main clause and optional detail', async () => {
    const clause = "that you can't do well without thinking differently from your peers"
    const connection = 'The clause beginning with “that” identifies the work. “Can’t … without” makes a different way of thinking necessary.'
    const completeArticle = `${LAYERED_SELECTION}, you need to ask useful questions.`
    const secondSentence = 'To be a successful scientist, you need to ask useful questions.'
    const scopeText = completeArticle.replace('. To be', '.\n\nTo be')
    const meaning = 'Some kinds of work require thinking differently from your peers.'
    const analysisGate = deferred()
    const requests = []
    const analysis = {
      paraphrase: 'Doing some work well requires independent thinking, and successful scientists ask useful questions.',
      structure: [
        { role: 'subject', text: 'There' },
        { role: 'verb', text: 'are' },
        { role: 'complement', text: 'some kinds of work' },
        { role: 'subject', text: 'you', occurrence: 2 },
        { role: 'verb', text: 'need to ask' },
        { role: 'object', text: 'useful questions' },
      ],
      sentenceAnalysis: {
        connections: [
          { text: 'There are', explanation: '“There are” introduces things that exist. “There” is a dummy subject; this clause has no object.' },
          { text: clause, explanation: connection },
        ],
        clauses: [{
          text: clause,
          explanation: '“You” is the subject; “can’t do” is the verb; “that” stands for the work and is its object.',
          structure: [
            { role: 'object', text: 'that' },
            { role: 'subject', text: 'you', occurrence: 1 },
            { role: 'verb', text: "can't do" },
          ],
        }],
      },
    }
    mock.setHandler(async ({ body, res, defaultResponse }) => {
      const data = sourceData(body)
      if (![LAYERED_SELECTION, scopeText].includes(data?.selectedText)) return defaultResponse({ body, res })
      const kind = isArticleExplanation(body) ? 'structure'
        : body.messages[0].content.includes('You are a patient reading tutor.') ? 'guide' : 'translate'
      requests.push(kind)
      if (kind === 'structure') {
        await analysisGate.promise
        return reply(res, analysis)
      }
      if (kind === 'translate') return reply(res, { translation: meaning })
      reply(res, {
        guideType: 'sentence',
        hints: ['“There are some kinds of work” is the main clause.', connection],
        answer: { meaning, explanation: connection },
        ...analysis,
      })
    })
    const articleHighlights = () => page.evaluate(() => Object.fromEntries(
      ['selection', 'subject', 'verb', 'object', 'complement'].flatMap((role) => {
        const ranges = CSS.highlights.get(`reading-lookup-${role}`)
        return ranges ? [[role, [...ranges].map((range) => range.toString())]] : []
      }),
    ))
    const mainHighlights = { subject: ['There', 'you'], verb: ['are', 'need to ask'], object: ['useful questions'], complement: ['some kinds of work'] }
    try {
      await withState(page, async () => {
        await openPastedText(page, completeArticle)
        await selectText(page, LAYERED_SELECTION)
        await page.locator('#reading-lookup-translate').click()
        const result = page.locator('#reading-lookup-result')
        await result.getByText(meaning, { exact: true }).waitFor()
        await until(() => requests.includes('structure'), 'the optional multi-sentence analysis request')
        assert.equal(await result.locator('.sentence-analysis').count(), 0, 'translation must display before optional analysis')
        assert.deepEqual(await articleHighlights(), { selection: [LAYERED_SELECTION] })
        analysisGate.resolve()
        await result.getByText(connection, { exact: true }).waitFor()
        assert.equal(await result.locator('.reading-sentence-source').last().textContent(), secondSentence)
        assert.equal(await result.locator('.sentence-fragment').count(), 0)
        const details = result.locator('#reading-sentence-toggle')
        assert.equal(await details.getAttribute('open'), '')
        await page.waitForFunction(() => CSS.highlights.has('reading-lookup-verb'))
        assert.deepEqual(await articleHighlights(), mainHighlights)
        await shot?.(page, 'main-article-layered-sentence')
        const beforeExpand = requests.length
        await details.locator(':scope > summary').click()
        await page.waitForFunction(() => !CSS.highlights.has('reading-lookup-verb'))
        await details.locator(':scope > summary').click()
        await page.waitForFunction(() => CSS.highlights.has('reading-lookup-verb'))
        assert.deepEqual(await articleHighlights(), mainHighlights)
        assert.deepEqual(await result.locator('.sentence-legend').first().locator('li').allTextContents(), ['Subject', 'Verb', 'Object', 'Complement'])
        await result.locator('.sentence-clause-source').waitFor({ state: 'visible' })
        assert.deepEqual(await result.locator('.sentence-clause-source mark').allTextContents(), ['that', 'you', "can't do"])
        assert.deepEqual(await result.locator('.sentence-clause-source mark').evaluateAll((marks) => marks.map((mark) => mark.dataset.role)), ['object', 'subject', 'verb'])
        assert.deepEqual(await articleHighlights(), mainHighlights, 'opening clause detail must leave the article focused on the main clause')
        assert.equal(requests.length, beforeExpand, 'opening existing clause detail must not request the model again')
        await result.locator('.sentence-clause-source').scrollIntoViewIfNeeded()
        await shot?.(page, 'main-article-layered-sentence-detail')

        await page.locator('#reading-lookup-guide').click()
        await result.locator('.hint').first().waitFor()
        const explanation = result.locator('#reading-sentence-explanation')
        assert.equal(await explanation.getAttribute('open'), null)
        assert.equal(await result.locator('.reading-sentence-paraphrase').isVisible(), false)
        await page.waitForFunction(() => CSS.highlights.has('reading-lookup-verb'))
        assert.deepEqual(await articleHighlights(), mainHighlights)
        await explanation.locator(':scope > summary').click()
        await result.locator('#reading-sentence-structure[data-status="done"]').waitFor()
        assert.equal(await result.locator('.reading-sentence-source').last().textContent(), secondSentence)
        assert.deepEqual(await articleHighlights(), mainHighlights)
        const beforeReveal = requests.length
        await result.getByRole('button', { name: 'Reveal answer', exact: true }).click()
        await result.locator('.answer').getByText(meaning, { exact: false }).waitFor()
        assert.equal(await details.getAttribute('open'), '', 'revealing the answer must preserve expanded clause detail')
        assert.equal(requests.length, beforeReveal, 'revealing the existing answer must not request the model again')
        assert.deepEqual(await articleHighlights(), mainHighlights)
      })
    } finally {
      analysisGate.resolve()
      mock.resetHandler()
    }
  })

  await check('article lookup: stale replies, close, stop, retry and independent workbench request', async () => {
    const gates = new Map(['orchard', 'meadow', 'canyon', 'workbench-background-probe'].map((text) => [text, deferred()]))
    const seen = new Map()
    const completed = new Set()
    mock.setHandler(async ({ body, res, defaultResponse }) => {
      if (isArticleExplanation(body)) return defaultResponse({ body, res })
      const data = sourceData(body)
      const text = data?.selectedText || body.messages.at(-1).content
      seen.set(text, (seen.get(text) || 0) + 1)
      if (gates.has(text) && seen.get(text) === 1) await gates.get(text).promise
      if (text === 'riverside' && seen.get(text) === 1) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end('{"error":{"message":"mock authentication failure"}}')
      } else if (data) reply(res, { translation: `Ready: ${text}` })
      else if (text === 'workbench-background-probe') reply(res, { translation: 'Background workbench completed' })
      else await defaultResponse({ body, res })
      completed.add(text)
    })
    try {
      await withState(page, async () => {
        await openPastedText(page, RACE_PASSAGE)
        await clickWord(page, 'orchard')
        await until(() => seen.has('orchard'), 'the first lookup request')
        await clickWord(page, 'harbor')
        await page.locator('#reading-lookup-result').getByText('Ready: harbor', { exact: true }).waitFor()
        gates.get('orchard').resolve()
        await until(() => completed.has('orchard'), 'the stale lookup response')
        assert.equal(await page.locator('#reading-lookup-text').textContent(), 'harbor')
        assert.equal(await page.locator('#reading-lookup-result').getByText('Ready: orchard', { exact: true }).count(), 0)

        await clickWord(page, 'meadow')
        await until(() => seen.has('meadow'), 'the lookup before closing')
        await page.locator('#reading-lookup-close').click()
        gates.get('meadow').resolve()
        await until(() => completed.has('meadow'), 'the closed lookup response')
        assert.equal(await page.locator('#reading-lookup').isVisible(), false)

        await clickWord(page, 'canyon')
        await until(() => seen.has('canyon'), 'the lookup before stopping')
        await page.locator('#reading-lookup-stop').click()
        await page.locator('#reading-lookup-retry').waitFor({ state: 'visible' })
        gates.get('canyon').resolve()
        await page.locator('#reading-lookup-retry').click()
        await page.locator('#reading-lookup-result').getByText('Ready: canyon', { exact: true }).waitFor()

        await clickWord(page, 'riverside')
        await page.locator('#reading-lookup-retry').waitFor({ state: 'visible' })
        await page.locator('#reading-lookup-retry').click()
        await page.locator('#reading-lookup-result').getByText('Ready: riverside', { exact: true }).waitFor()

        await page.locator('#btn-translate-workspace').click()
        await page.locator('#input').fill('workbench-background-probe')
        await page.locator('#btn-send').click()
        await until(() => seen.has('workbench-background-probe'), 'the workbench request')
        await page.locator('#btn-tutor-workspace').click()
        await clickWord(page, 'harbor')
        await page.locator('#reading-lookup-result').getByText('Ready: harbor', { exact: true }).waitFor()
        gates.get('workbench-background-probe').resolve()
        await page.locator('#btn-translate-workspace').click()
        await page.locator('.entry:last-child .result').getByText('Background workbench completed', { exact: true }).waitFor()
        assert.equal(await page.locator('#input').inputValue(), 'workbench-background-probe')
        await page.locator('#btn-tutor-workspace').click()
        assert.equal(await page.locator('#reading-lookup').isVisible(), false)
        assert.ok((await page.locator('.reading-preview').first().textContent()).includes(RACE_PASSAGE))
      })
    } finally {
      for (const gate of gates.values()) gate.resolve()
      mock.resetHandler()
    }
  })

  await check('article lookup: short dark viewport, Escape and article navigation', async () => {
    let previousBounds
    mock.setHandler(async ({ body, res, defaultResponse }) => {
      const data = sourceData(body)
      if (!data || isArticleExplanation(body)) return defaultResponse({ body, res })
      reply(res, guide(data))
    })
    try {
      await withState(page, async () => {
        await openPastedText(page, PASSAGE)
        previousBounds = await app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('index.html'))
          const bounds = win.getBounds()
          win.setContentSize(580, 500)
          return bounds
        })
        await page.waitForFunction(() => innerWidth === 580 && innerHeight === 500)
        await page.evaluate(() => {
          const theme = document.getElementById('opt-theme')
          theme.value = 'dark'
          theme.dispatchEvent(new Event('change', { bubbles: true }))
        })
        await selectText(page, 'put off')
        await page.locator('#reading-lookup-guide').click()
        await page.locator('#reading-lookup-result .hint').first().waitFor()
        await page.locator('#reading-lookup-result').getByRole('button', { name: 'Reveal answer', exact: true }).click()
        const bounds = await page.locator('#reading-lookup').evaluate((node) => {
          const rect = node.getBoundingClientRect()
          return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight }
        })
        assert.ok(bounds.left >= 0 && bounds.top >= 0, 'lookup must stay within the viewport origin')
        assert.ok(bounds.right <= bounds.width && bounds.bottom <= bounds.height, 'lookup must stay within the viewport edges')
        await shot?.(page, 'main-article-lookup-small-dark')
        await page.keyboard.press('Escape')
        await page.locator('#reading-lookup').waitFor({ state: 'hidden' })
        const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
          .find((item) => item.webContents.getURL().includes('index.html')).isVisible())
        assert.equal(visible, true, 'Escape must close the lookup before hiding the application')
        await selectText(page, 'put off')
        await page.locator('#reading-lookup-translate').click()
        await page.locator('#reading-back').click()
        assert.equal(await page.locator('#reading-lookup').isVisible(), false)
        await page.locator('#reading-articles').waitFor({ state: 'visible' })
      })
    } finally {
      if (previousBounds) await app.evaluate(({ BrowserWindow }, bounds) => {
        BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('index.html')).setBounds(bounds)
      }, previousBounds)
      mock.resetHandler()
    }
  })

  await check('article lookup: dictionary resize and immediate word lookup', async () => {
    let previousBounds
    mock.setHandler(async ({ body, res, defaultResponse }) => {
      if (body.messages?.[0]?.content?.includes('Read an English article together')) {
        reply(res, { reply: 'The passage explains how the team keeps its decisions available.', quote: '', followups: [] })
        return
      }
      const data = sourceData(body)
      if (!data || isArticleExplanation(body)) return defaultResponse({ body, res })
      reply(res, {
        translation: translation(data),
        phonetic: '/rɪˈkɔːrd/',
        definitions: [{
          pos: 'v.', meaning: 'to capture sound or information so it can be used later',
          example: { source: 'They record the discussion before sharing their notes.', target: '他们先录下讨论，再分享笔记。' },
        }],
        contextual_analysis: 'The first occurrence follows “will” and describes saving the interview. The second occurrence follows “a” and names the copy that the team will keep.',
      })
    })
    try {
      await withState(page, async () => {
        await openPastedText(page, PASSAGE)
        previousBounds = await app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('index.html'))
          const bounds = win.getBounds()
          win.setContentSize(620, 500)
          return bounds
        })
        await page.waitForFunction(() => innerWidth === 620 && innerHeight === 500)
        await clickWord(page, 'record')
        if (await page.locator('#reading-lookup-expand').isVisible()) await page.locator('#reading-lookup-expand').click()
        await page.locator('#reading-lookup-result .lexical-details summary').click()
        await page.locator('#reading-lookup-result .definitions').waitFor({ state: 'visible' })
        await page.waitForFunction(() => {
          const rect = document.getElementById('reading-lookup').getBoundingClientRect()
          return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight
        })
        assert.equal(await page.locator('#reading-lookup-close').evaluate((button) => {
          const rect = button.getBoundingClientRect()
          return button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))
        }), true, 'expanding dictionary details must keep the close action clickable')
        await shot?.(page, 'main-article-lookup-dictionary-small')

        await selectText(page, 'put off')
        await page.locator('#reading-lookup-close').click()
        assert.equal(await page.evaluate(() => window.getSelection().toString()), 'put off')
        await page.locator('#reading-start').click()
        await page.locator('#reading-thread').getByText('The passage explains how the team keeps its decisions available.', { exact: true }).waitFor()
        assert.equal(await page.locator('#reading-lookup').isVisible(), false,
          'clicking Coach with an earlier article selection must not reopen its lookup')

        await page.evaluate(() => window.getSelection().removeAllRanges())
        const point = await textRange(page, 'record')
        const panel = page.locator('#reading-lookup')
        await panel.evaluate((node) => {
          document.addEventListener('click', () => {
            node.dataset.openOnClick = String(!node.hidden)
          }, { once: true })
        })
        await page.mouse.click(point.x, point.y)
        assert.equal(await panel.getAttribute('data-open-on-click'), 'true', 'a single click must open the lookup in the click event')
        await page.locator('#btn-settings').click()
        await page.locator('#settings-panel').waitFor({ state: 'visible' })
        await page.locator('#btn-close-settings').click()

        const scrolled = await page.locator('#tutor-workspace').evaluate((node) => {
          const before = node.scrollTop
          node.scrollTop += before > 0 ? -24 : 24
          return node.scrollTop !== before
        })
        assert.equal(scrolled, true, 'the test must actually scroll the article')
        await panel.getByText('录制采访', { exact: true }).waitFor()
        assert.equal(await page.locator('#reading-lookup-text').textContent(), 'record')
      })
    } finally {
      if (previousBounds) await app.evaluate(({ BrowserWindow }, bounds) => {
        BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('index.html')).setBounds(bounds)
      }, previousBounds)
      mock.resetHandler()
    }
  })
}
