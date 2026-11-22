import assert from 'node:assert/strict'

const PASTED = Array.from({ length: 70 }, (_value, index) => `History paragraph ${index + 1}. The research team compared its observations with an independent reference. They checked every measurement before accepting the final report.`).join('\n\n')

async function enterReading(page) {
  await page.locator('#btn-tutor-workspace').click()
  await page.locator('#tutor-reading-mode').click()
  if (await page.locator('#reading-back').isVisible()) await page.locator('#reading-back').click()
}

export async function verifyReadingHistory({ page, check, shot }) {
  await check('Reading history: pasted snapshots and reading positions survive a renderer restart', async () => {
    await enterReading(page)
    await page.locator('#reading-paste').click()
    await page.locator('#reading-paste-text').fill(PASTED)
    await page.locator('#reading-paste-open').click()
    await page.locator('#reading-detail .reading-preview').waitFor()
    assert.equal(await page.locator('#reading-detail .reading-preview').textContent(), PASTED)
    const saved = await page.evaluate(async () => (await window.sttDesktop.reading.history())
      .find((article) => article.excerpt.startsWith('History paragraph 1.')))
    assert.ok(saved?.id)
    await page.evaluate(() => { document.getElementById('tutor-workspace').scrollTop = 2200 })
    await page.waitForFunction(async (id) => (await window.sttDesktop.reading.history())
      .find((article) => article.id === id)?.progress > 0.05, saved.id)
    const previousTop = await page.locator('#tutor-workspace').evaluate((node) => node.scrollTop)
    await page.locator('#tutor-review-mode').evaluate((node) => node.click())
    await page.locator('#tutor-review-panel').waitFor({ state: 'visible' })
    await page.locator('#btn-translate-workspace').click()
    await page.locator('#btn-tutor-workspace').click()
    await page.locator('#tutor-reading-mode').evaluate((node) => node.click())
    await page.waitForFunction((top) => Math.abs(document.getElementById('tutor-workspace').scrollTop - top) < 50, previousTop)
    await page.locator('#btn-translate-workspace').click()
    await page.locator('#btn-tutor-workspace').click()
    await page.waitForFunction((top) => Math.abs(document.getElementById('tutor-workspace').scrollTop - top) < 50, previousTop)
    await page.locator('#reading-back').click()
    await page.locator('#reading-history').click()
    await page.locator(`.reading-history-open[data-history-id="${saved.id}"]`).waitFor()
    await shot?.(page, 'main-tutor-reading-history')

    await page.reload()
    await enterReading(page)
    await page.locator('#reading-history').click()
    await page.locator(`.reading-history-open[data-history-id="${saved.id}"]`).click()
    await page.waitForFunction((top) => Math.abs(document.getElementById('tutor-workspace').scrollTop - top) < 50, previousTop)
    assert.equal(await page.locator('#reading-detail .reading-preview').textContent(), PASTED)
  })

  await check('Reading history: background imports remain available, URLs deduplicate, failures do not save', async () => {
    await enterReading(page)
    const savedConfig = await page.evaluate(() => chrome.storage.sync.get('desktop_iqs_api_key'))
    try {
      await page.evaluate(async () => {
        await chrome.storage.sync.set({ desktop_iqs_api_key: 'iqs-mock-key' })
        const api = window.sttDesktop.reading
        window.__historyImportOriginal = api.importPage
        api.importPage = (url) => new Promise((resolve, reject) => {
          window.__finishHistoryImport = () => window.__historyImportOriginal(url).then(resolve, reject)
        })
      })
      const url = 'https://reader.example.org/articles/history-fixture'
      await page.locator('#reading-import').click()
      await page.locator('#reading-import-url').fill(`${url}#first`)
      await page.getByRole('button', { name: 'Import article', exact: true }).click()
      await page.locator('#reading-import-status').getByText('Importing article…', { exact: true }).waitFor()
      await page.locator('#reading-back').click()
      await page.locator('#reading-history').click()
      await page.evaluate(() => window.__finishHistoryImport())
      await page.locator('#reading-import-notice').waitFor({ state: 'visible' })
      assert.equal(await page.locator('#reading-detail').count(), 0, 'background import must not replace the current view')
      const imported = await page.evaluate(async (url) => (await window.sttDesktop.reading.history()).find((article) => article.url === url), url)
      assert.ok(imported)
      await page.locator(`.reading-history-open[data-history-id="${imported.id}"]`).waitFor()
      await page.locator('#reading-import-notice-open').click()
      assert.equal(await page.locator('#reading-original').getAttribute('href'), url)

      const result = await page.evaluate(async (url) => {
        window.sttDesktop.reading.importPage = window.__historyImportOriginal
        const again = await window.sttDesktop.reading.importPage(`${url}#second`)
        const list = await window.sttDesktop.reading.history()
        const beforeFailure = list.length
        try { await window.sttDesktop.reading.importPage('invalid link') } catch {}
        return { id: again.historyId, matching: list.filter((article) => article.url === url).length,
          beforeFailure, afterFailure: (await window.sttDesktop.reading.history()).length }
      }, url)
      assert.equal(result.id, imported.id)
      assert.equal(result.matching, 1)
      assert.equal(result.beforeFailure, result.afterFailure)
    } finally {
      await page.evaluate(async (saved) => {
        if (window.__historyImportOriginal) window.sttDesktop.reading.importPage = window.__historyImportOriginal
        if (Object.hasOwn(saved, 'desktop_iqs_api_key')) await chrome.storage.sync.set(saved)
        else await chrome.storage.sync.remove('desktop_iqs_api_key')
      }, savedConfig)
    }
  })

  await check('Reading history: remove and clear stay empty after stale position saves', async () => {
    await enterReading(page)
    await page.locator('#reading-history').click()
    const first = await page.evaluate(async () => (await window.sttDesktop.reading.history())[0])
    assert.ok(first)
    const row = page.locator(`.reading-history-open[data-history-id="${first.id}"]`).locator('..').locator('..')
    await row.locator('.reading-history-remove').click()
    await page.waitForFunction(async (id) => !(await window.sttDesktop.reading.history()).some((article) => article.id === id), first.id)
    assert.equal(await page.evaluate((id) => window.sttDesktop.reading.savePosition({ id, position: { offset: 100 } }), first.id), false)
    await page.locator('#reading-history-clear').click()
    await page.waitForFunction(async () => !(await window.sttDesktop.reading.history()).length)
    await page.reload()
    await enterReading(page)
    await page.locator('#reading-history').click()
    assert.equal(await page.locator('.reading-history-open').count(), 0)
    await page.getByText('No imported articles yet. Open a link or paste text to start reading.', { exact: true }).waitFor()
    await page.locator('#reading-category-news').click()
    await page.locator('#reading-articles').waitFor({ state: 'visible' })
    await page.locator('#btn-translate-workspace').click()
  })
}
