import assert from 'node:assert/strict'

export async function verifySettings({ app, page, check, shot }) {
  await check('settings: grouped sections preserve edits and open the right API key consoles', async () => {
    const modelConsole = 'https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key'
    const iqsConsole = 'https://aisearch.aliyun.com/web-parsing?tab=docs&apiTab=scrape'
    await app.evaluate(({ shell }) => {
      globalThis.settingsConsoleProbe = { original: shell.openExternal, urls: [] }
      shell.openExternal = async (url) => { globalThis.settingsConsoleProbe.urls.push(url) }
    })
    let previousBounds
    const previousTheme = await page.locator('#opt-theme').inputValue()
    try {
      await page.locator('#btn-settings').click()
      const nav = page.locator('.settings-nav')
      assert.equal(await nav.getByRole('link').count(), 4)
      assert.equal(await page.locator('.settings-page:not([hidden])').getAttribute('data-settings-page'), 'models')
      const modelLink = page.locator('[data-settings-page="models"] .bailian-console-link')
      assert.equal(await modelLink.getAttribute('href'), modelConsole)
      await modelLink.click()
      await shot(page, 'main-settings-models')

      await nav.getByRole('link', { name: 'Reading', exact: true }).click()
      assert.equal(await page.locator('.settings-page:not([hidden])').getAttribute('data-settings-page'), 'reading')
      assert.equal(await page.locator('#model-settings-form').isVisible(), false)
      await page.locator('#cfg-iqs-key').fill('unsaved-iqs-test-key')
      assert.equal(await page.locator('#iqs-console-link').getAttribute('href'), iqsConsole)
      await page.locator('#iqs-console-link').click()
      await page.locator('[data-settings-page="reading"] .bailian-console-link').click()
      assert.deepEqual(await app.evaluate(() => globalThis.settingsConsoleProbe.urls), [modelConsole, iqsConsole, modelConsole])

      await nav.getByRole('link', { name: 'Preferences', exact: true }).click()
      assert.equal(await page.locator('#opt-target-language').isVisible(), true)
      await nav.getByRole('link', { name: 'Data', exact: true }).click()
      assert.equal(await page.locator('#btn-archive-export').isVisible(), true)
      await nav.getByRole('link', { name: 'Reading', exact: true }).click()
      assert.equal(await page.locator('#cfg-iqs-key').inputValue(), 'unsaved-iqs-test-key')
      await page.locator('#cfg-iqs-key').clear()
      await shot(page, 'main-settings-reading')

      previousBounds = await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('index.html'))
        const bounds = win.getBounds()
        win.setContentSize(580, 500)
        return bounds
      })
      await page.waitForFunction(() => innerWidth === 580 && innerHeight === 500)
      await nav.getByRole('link', { name: 'Preferences', exact: true }).click()
      await page.locator('#opt-theme').selectOption('dark')
      await nav.getByRole('link', { name: 'Reading', exact: true }).click()
      assert.equal(await nav.getByRole('link', { name: 'Reading', exact: true }).getAttribute('aria-current'), 'page')
      assert.equal(await page.locator('#web-import-settings-form').evaluate((form) => form.scrollWidth > form.clientWidth), false)
      await shot(page, 'main-settings-reading-small-dark')
    } finally {
      await page.locator('.settings-nav').getByRole('link', { name: 'Preferences', exact: true }).click()
      await page.locator('#opt-theme').selectOption(previousTheme)
      await page.locator('#btn-close-settings').click()
      if (previousBounds) await app.evaluate(({ BrowserWindow }, bounds) => {
        BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('index.html')).setBounds(bounds)
      }, previousBounds)
      await app.evaluate(({ shell }) => {
        shell.openExternal = globalThis.settingsConsoleProbe.original
        delete globalThis.settingsConsoleProbe
      })
    }
  })
}
