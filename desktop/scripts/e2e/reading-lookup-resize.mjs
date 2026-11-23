import assert from 'node:assert/strict'
import { isArticleExplanation } from './mock-api.mjs'
import { openPastedText, selectText, withState } from './reading-lookup.mjs'

const WIDTH_KEY = 'desktop_reading_lookup_width'
const PASSAGE = Array.from({ length: 45 }, (_, index) => `Observation ${index + 1}: The engineering team compares each measurement against an independent reference before continuing. This careful process keeps the complete report useful for readers and helps the team understand unexpected changes.`).join('\n\n')
const WIDE_SENTENCE = 'The engineers tested a local copy of the package before touching the public index.'
const WIDE_PASSAGE = [
  'Rehearsing a software release',
  'A package release can look simple from the outside. A new version number appears, and people can install it. Inside a team, a release brings together source code, build scripts, documentation, and systems for distributing files.',
  `${WIDE_SENTENCE} They installed the copy on a clean machine and ran the same commands that a first-time user would run. This uncovered a file that was present on every developer’s laptop but missing from the package.`,
  'The team kept the rehearsal close to the real release. A small test server accepted uploads and exposed the same download paths as the public index. A separate account installed the release so that its permissions matched those of an ordinary user.',
  'The rehearsal also showed what to measure. The tests recorded how long it took to install the package on each platform and checked that the downloaded files matched the files built earlier. The team could compare those results with the next release.',
  'When a check failed, the team fixed the process as well as the package. They added a reminder only when they needed a human to make a decision. Checks for missing files and invalid version numbers moved into the build script, where every contributor could run them.',
  'After a few releases, the rehearsal became a regular part of development. The team could try a change to the build system on an ordinary day, while the earlier release was still available. Preparing a release then became one more opportunity to find a defect early.',
].join('\n\n')

function fontSize(locator) {
  return locator.evaluate((node) => getComputedStyle(node).fontSize)
}

async function resizeWindow(app, page, width, height = 800) {
  await app.evaluate(({ BrowserWindow }, { width, height }) => {
    BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes('index.html')).setContentSize(width, height)
  }, { width, height })
  try {
    await page.waitForFunction((width) => Math.abs(innerWidth - width) <= 1, width, { timeout: 5000 })
  } catch (error) {
    const actual = await page.evaluate(() => innerWidth)
    throw new Error(`Window width ${actual}px did not reach ${width}px`, { cause: error })
  }
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

async function openLookup(page) {
  await page.locator('#btn-tutor-workspace').click()
  await page.locator('#tutor-reading-mode').click()
  if (await page.locator('#reading-back').isVisible()) await page.locator('#reading-back').click()
  await page.locator('#reading-paste').click()
  await page.locator('#reading-paste-text').fill(PASSAGE)
  await page.locator('#reading-paste-open').click()
  await page.evaluate(async () => {
    const material = document.querySelector('.reading-preview')
    const { rangeForOffsets } = await import(new URL('./reading-selection.js', location.href))
    const start = material.textContent.indexOf('Observation 18:')
    const range = rangeForOffsets(material, start, start + 'Observation'.length)
    const scroller = document.getElementById('tutor-workspace')
    scroller.scrollTop += range.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 100
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    const rect = range.getClientRects()[0]
    material.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, detail: 1,
      clientX: rect.left + 1, clientY: rect.top + 1 }))
  })
  await page.locator('#reading-lookup[data-placement="side"]').waitFor()
}

async function geometry(page) {
  return page.evaluate(async () => {
    const material = document.querySelector('.reading-preview')
    const { rangeForOffsets } = await import(new URL('./reading-selection.js', location.href))
    const start = material.textContent.indexOf('Observation 18:')
    const source = rangeForOffsets(material, start, start + 'Observation'.length)
    const scroller = document.getElementById('tutor-workspace')
    return {
      sidebar: document.querySelector('.reading-lookup-dock').getBoundingClientRect().width,
      reading: scroller.getBoundingClientRect().width,
      sourceTop: source.getBoundingClientRect().top,
      overflow: document.documentElement.scrollWidth > innerWidth,
    }
  })
}

async function dragDivider(page, delta) {
  const grip = await page.locator('#reading-lookup-resize').boundingBox()
  assert.ok(grip, 'the sidebar divider should be visible')
  const x = grip.x + grip.width / 2
  const y = grip.y + Math.min(180, grip.height / 2)
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x - delta, y, { steps: 12 })
  await page.mouse.up()
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

export async function verifyReadingLookupResize({ app, page, mock, check, shot }) {
  await check('article lookup: resize sidebar, retain reading position and saved width, adapt narrow windows', async () => {
    const saved = await page.evaluate((key) => chrome.storage.local.get(key), WIDTH_KEY)
    const bounds = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes('index.html')).getBounds())
    try {
      await resizeWindow(app, page, 1280)
      await openLookup(page)
      await page.locator('#reading-lookup-resize').dblclick()
      const initial = await geometry(page)
      await dragDivider(page, 200)
      const wider = await geometry(page)
      assert.ok(Math.abs(wider.sidebar - initial.sidebar - 200) <= 2, 'dragging left should widen the sidebar')
      assert.ok(Math.abs(wider.sourceTop - initial.sourceTop) <= 66, 'the reading passage should remain near its original line')
      assert.ok(wider.reading >= 440 && !wider.overflow, 'resizing should leave room for readable prose')
      await page.waitForFunction(async ({ key, width }) =>
        (await chrome.storage.local.get(key))[key] === Math.round(width), { key: WIDTH_KEY, width: wider.sidebar })

      const beforeClose = await page.evaluate(async () => {
        const material = document.querySelector('.reading-preview')
        const { rangeForOffsets } = await import(new URL('./reading-selection.js', location.href))
        const start = material.textContent.indexOf('Observation 28:')
        const range = rangeForOffsets(material, start, start + 'Observation'.length)
        const scroller = document.getElementById('tutor-workspace')
        scroller.scrollTop += range.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 75
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        window.__readingResizeCloseAnchor = range
        return range.getBoundingClientRect().top
      })
      await page.locator('#reading-lookup-close').click()
      const afterClose = await page.evaluate(() => {
        const top = window.__readingResizeCloseAnchor.getBoundingClientRect().top
        delete window.__readingResizeCloseAnchor
        return top
      })
      assert.ok(Math.abs(afterClose - beforeClose) <= 66,
        'closing a widened sidebar should preserve the current passage even after scrolling away from the lookup source')
      await openLookup(page)
      assert.ok(Math.abs((await geometry(page)).sidebar - wider.sidebar) <= 1)

      await resizeWindow(app, page, 960)
      const limited = await geometry(page)
      assert.ok(limited.sidebar <= 520 && limited.reading >= 440, 'a smaller window should clamp the sidebar width')
      await resizeWindow(app, page, 1280)
      assert.ok(Math.abs((await geometry(page)).sidebar - wider.sidebar) <= 1, 'a wider window should restore the preferred width')
      await shot?.(page, 'main-article-lookup-resized')

      await dragDivider(page, 1000)
      assert.equal((await geometry(page)).sidebar, 720, 'the sidebar should have a useful maximum width')
      await dragDivider(page, -1000)
      assert.equal((await geometry(page)).sidebar, 280, 'the sidebar should not shrink below its minimum width')
      await dragDivider(page, 260)
      const persisted = (await geometry(page)).sidebar
      await page.waitForFunction(async ({ key, width }) =>
        (await chrome.storage.local.get(key))[key] === width, { key: WIDTH_KEY, width: persisted })
      await page.reload()
      await openLookup(page)
      assert.equal((await geometry(page)).sidebar, persisted, 'reloading should retain the local width preference')

      await resizeWindow(app, page, 620)
      await page.locator('#reading-lookup[data-placement="inline"]').waitFor()
      assert.equal(await page.locator('#reading-lookup-resize').isVisible(), false)
      await page.locator('#reading-lookup-expand').click()
      await page.locator('#reading-lookup[data-placement="bottom"]').waitFor()
      await page.locator('#reading-lookup-minimize').click()
      await page.locator('#reading-lookup-reopen').click()
      await page.locator('#reading-lookup[data-placement="bottom"]').waitFor()
      await resizeWindow(app, page, 1280)
      await page.locator('#reading-lookup[data-placement="side"]').waitFor()
      assert.equal((await geometry(page)).sidebar, persisted)
      await page.locator('#reading-lookup-resize').dblclick()
      assert.ok(Math.abs((await geometry(page)).sidebar - initial.sidebar) <= 1, 'double-click should restore the default width')
      await page.waitForFunction(async (key) => !Object.hasOwn(await chrome.storage.local.get(key), key), WIDTH_KEY)
    } finally {
      if (await page.locator('#reading-lookup-close').isVisible()) await page.locator('#reading-lookup-close').click()
      await page.locator('#btn-translate-workspace').click()
      await page.evaluate(async ({ key, saved }) => {
        if (Object.hasOwn(saved, key)) await chrome.storage.local.set(saved)
        else await chrome.storage.local.remove(key)
      }, { key: WIDTH_KEY, saved })
      await app.evaluate(({ BrowserWindow }, bounds) =>
        BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes('index.html')).setBounds(bounds), bounds)
    }
  })

  await check('article lookup: wide reading layout and independent text sizes', async () => {
    const { bounds, workArea } = await app.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('index.html'))
      const bounds = window.getBounds()
      return { bounds, workArea: screen.getDisplayMatching(bounds).workArea }
    })
    const widest = Math.max(1280, workArea.width)
    const height = Math.min(workArea.height, 2160)
    mock.setHandler(async ({ body, res }) => {
      const prompt = body.messages[0].content
      let result = { translation: '工程师先测试了软件包的本地副本，然后才操作公开索引。' }
      if (isArticleExplanation(body)) {
        result = {
          paraphrase: 'The engineers checked a local copy before making any changes to the public index.',
          structure: [
            { role: 'subject', text: 'The engineers' }, { role: 'verb', text: 'tested' },
            { role: 'object', text: 'a local copy of the package' },
          ],
          sentenceAnalysis: { connections: [{ text: 'before touching the public index',
            explanation: '“Before” tells us that testing the copy happened first. The same engineers did both actions.' }] },
        }
      } else if (prompt.includes('You are a patient reading tutor.')) {
        result = {
          guideType: 'sentence',
          hints: [
            'Start with “The engineers tested a local copy.” This is the main action in the sentence.',
            'Look at “before touching the public index.” This puts the testing and the work on the public index in order.',
          ],
          answer: {
            meaning: 'The engineers tried the package on their own machines first, then worked with the public list of packages.',
            explanation: 'The word “before” tells you which action happened first.',
          },
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }))
    })
    try {
      await withState(page, async () => {
        await app.evaluate(({ BrowserWindow }, { x, y }) => {
          BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes('index.html')).setPosition(x, y)
        }, workArea)
        await resizeWindow(app, page, widest, height)
        await openPastedText(page, WIDE_PASSAGE)
        await selectText(page, WIDE_SENTENCE)
        const article = page.locator('.reading-preview').first()
        const snapshot = page.locator('#reading-lookup')
        const translation = snapshot.locator('.translation-text')
        const hint = snapshot.locator('.hint-text').first()
        const answer = snapshot.locator('.answer')
        const analysis = snapshot.locator('.reading-sentence-structure .sentence-analysis')
        await translation.waitFor()
        await snapshot.locator('.reading-sentence-paraphrase').waitFor()
        assert.equal(await snapshot.locator('#reading-sentence-toggle').getAttribute('open'), '')
        assert.equal(await fontSize(article), '18px')
        assert.equal(await fontSize(translation), '18px')
        await page.locator('#reading-lookup-guide').click()
        await snapshot.locator('[data-hint-more]').click()
        await snapshot.getByRole('button', { name: 'Reveal answer', exact: true }).click()
        await snapshot.locator('#reading-sentence-explanation > summary').click()
        await analysis.waitFor()
        assert.equal(await fontSize(answer), '18px')
        assert.equal(await fontSize(hint), '16px')
        assert.equal(await fontSize(analysis), '16px')

        for (const width of [widest, ...[2560, 1920].filter((width) => width < widest)]) {
          if (width !== widest) await resizeWindow(app, page, width, height)
          await snapshot.locator('[data-hints]').waitFor()
          const layout = await article.evaluate((node) => {
            const prose = node.getBoundingClientRect()
            const sidebar = document.querySelector('.reading-lookup-dock').getBoundingClientRect()
            return {
              gap: sidebar.left - prose.right,
              leftMargin: prose.left,
              rightMargin: innerWidth - sidebar.right,
              sidebar: sidebar.width,
              overflow: document.documentElement.scrollWidth > innerWidth,
            }
          })
          assert.ok(!layout.overflow && layout.gap >= 0 && layout.gap <= 72,
            `keep the sidebar near the prose at ${width}px: ${JSON.stringify(layout)}`)
          if (width >= 1920) {
            assert.ok(layout.sidebar >= 410 && layout.sidebar <= 500, 'wide windows should give the sidebar room')
            assert.ok(Math.abs(layout.leftMargin - layout.rightMargin) <= 72, 'the reading and lookup columns should be centered together')
          }
          if (width === widest) await shot?.(page, 'main-article-lookup-wide')
        }

        await resizeWindow(app, page, 1280, 860)
        const initialRatio = await page.evaluate(() => devicePixelRatio)
        const zoom = page.getByLabel('Interface zoom')
        const preferences = page.locator('.settings-nav').getByRole('link', { name: 'Preferences', exact: true })
        await page.locator('#btn-settings').click()
        await preferences.click()
        try {
          await zoom.selectOption('1.25')
          await page.waitForFunction(() => Math.abs(innerWidth - 1024) <= 1)
          await page.locator('#btn-close-settings').click()
          await snapshot.locator('[data-hints]').waitFor()
          assert.equal(await snapshot.getAttribute('data-placement'), 'side', 'keep the lookup alongside the article when there is room at 125%')
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
        } finally {
          if (!(await zoom.isVisible())) await page.locator('#btn-settings').click()
          await preferences.click()
          await zoom.selectOption('1')
          await page.waitForFunction((ratio) => Math.abs(devicePixelRatio - ratio) < 0.001, initialRatio)
          await page.locator('#btn-close-settings').click()
          await resizeWindow(app, page, widest, height)
        }

        await page.locator('#btn-settings').click()
        await page.locator('.settings-nav').getByRole('link', { name: 'Reading', exact: true }).click()
        await page.locator('#opt-reading-lookup-font').selectOption('22')
        await page.locator('#btn-close-settings').click()
        assert.equal(await fontSize(article), '18px', 'changing the lookup size should leave the prose unchanged')
        assert.equal(await fontSize(answer), '22px')
        assert.equal(await fontSize(hint), '20px')
        assert.equal(await fontSize(analysis), '20px')
        await page.waitForFunction(async () =>
          (await chrome.storage.sync.get('desktop_prefs')).desktop_prefs?.articleAppearance?.lookupFont === 22)
        await page.reload()
        await openPastedText(page, WIDE_PASSAGE)
        await selectText(page, WIDE_SENTENCE)
        await hint.waitFor()
        assert.equal(await fontSize(article), '18px')
        assert.equal(await fontSize(hint), '20px', 'the lookup text size should survive a reload')
      })
    } finally {
      mock.resetHandler()
      await app.evaluate(({ BrowserWindow }, bounds) =>
        BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes('index.html')).setBounds(bounds), bounds)
      await page.reload()
    }
  })
}
