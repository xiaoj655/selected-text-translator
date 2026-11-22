import assert from 'node:assert/strict'

const WIDTH_KEY = 'desktop_reading_lookup_width'
const PASSAGE = Array.from({ length: 45 }, (_, index) => `Observation ${index + 1}: The engineering team compares each measurement against an independent reference before continuing. This careful process keeps the complete report useful for readers and helps the team understand unexpected changes.`).join('\n\n')

async function resizeWindow(app, page, width, height = 800) {
  await app.evaluate(({ BrowserWindow }, { width, height }) => {
    BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes('index.html')).setContentSize(width, height)
  }, { width, height })
  await page.waitForFunction((width) => innerWidth === width, width)
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

export async function verifyReadingLookupResize({ app, page, check, shot }) {
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
}
