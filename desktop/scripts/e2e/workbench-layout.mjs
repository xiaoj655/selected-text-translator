import assert from 'node:assert/strict'

export async function verifyWorkbenchLayout({ app, page, check, shot, openSettings, source, translation }) {
  await check('workbench layout: wide window and zoomed split screen', async () => {
    const { previousBounds, workArea } = await app.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('index.html'))
      const previousBounds = win.getBounds()
      return { previousBounds, workArea: screen.getDisplayMatching(previousBounds).workArea }
    })
    async function resize(width, height) {
      await app.evaluate(({ BrowserWindow }, { width, height, x, y }) => {
        const win = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('index.html'))
        win.setPosition(x, y)
        win.setContentSize(width, height)
      }, { width, height, x: workArea.x, y: workArea.y })
      await page.waitForFunction((width) => Math.abs(innerWidth - width) <= 1, width, { timeout: 5000 })
    }
    try {
      await resize(Math.max(1600, workArea.width), Math.min(1440, workArea.height))
      await page.evaluate((text) => window.sttDesktop.copyText(text), source)
      await page.locator('#btn-paste-translate').click()
      await page.locator('.translation-text', { hasText: translation }).waitFor()
      const layout = await page.evaluate(() => {
        const rect = (selector) => document.querySelector(selector).getBoundingClientRect()
        return {
          composer: rect('.composer-box').width,
          result: rect('.entry').width,
          measure: rect('.entry .result').width,
          inputFont: parseFloat(getComputedStyle(document.querySelector('#input')).fontSize),
          settingsRight: rect('#btn-settings').right,
          composerRight: rect('.composer-box').right,
        }
      })
      assert.ok(layout.composer > 900 && layout.composer <= 960, 'the workbench should use more space in a wide window')
      assert.ok(Math.abs(layout.result - layout.composer) < 1, 'input and result should line up')
      assert.ok(layout.measure < layout.result, 'limit the length of translated lines')
      assert.ok(layout.inputFont >= 18, 'use a larger workbench text size in wide windows')
      assert.ok(Math.abs(layout.settingsRight - layout.composerRight) <= 160, 'keep Settings near the workbench')
      await page.locator('#btn-more').click()
      const menu = await page.locator('#more-menu').boundingBox()
      const more = await page.locator('#btn-more').boundingBox()
      assert.ok(menu && more && Math.abs(menu.x + menu.width - more.x - more.width) <= 12,
        'keep the More menu aligned with its trigger')
      await page.locator('#btn-more').click()
      await shot(page, 'main-workbench-wide')

      await resize(760, 720)
      await openSettings(page)
      await page.locator('#opt-interface-zoom').selectOption('1.25')
      await page.waitForFunction(() => innerWidth === 608)
      await page.locator('#btn-close-settings').click()
      await page.locator('.mode[data-mode="guide"]').click()
      assert.equal(await page.locator('.mode[data-mode="guide"]').getAttribute('aria-pressed'), 'true')
      const fits = await page.locator('#btn-send').evaluate((button) => {
        const bounds = button.getBoundingClientRect()
        return document.documentElement.scrollWidth <= innerWidth
          && bounds.left >= 0 && bounds.right <= innerWidth
      })
      assert.equal(fits, true, 'fit the primary action inside the zoomed split window')
      await page.locator('#btn-send').click({ trial: true })
    } finally {
      await openSettings(page)
      await page.locator('#opt-interface-zoom').selectOption('1')
      await page.locator('#btn-close-settings').click()
      await page.locator('.mode[data-mode="translate"]').click()
      await page.locator('#btn-clear-input').click()
      await app.evaluate(({ BrowserWindow }, bounds) => {
        BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('index.html')).setBounds(bounds)
      }, previousBounds)
    }
  })
}

export async function verifyInterfaceZoom({ app, page, check, openSettings, restart }) {
  await check('interface zoom: settings, shortcuts, and restart share the saved scale', async () => {
    const initialRatio = await page.evaluate(() => devicePixelRatio)
    const waitForScale = (scale) => page.waitForFunction((ratio) => Math.abs(devicePixelRatio - ratio) < 0.001,
      initialRatio * scale, { timeout: 5000 })
    const zoom = () => page.locator('#opt-interface-zoom')
    const press = (keyCode) => app.evaluate(({ BrowserWindow }, keyCode) => {
      const win = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('index.html'))
      win.focus()
      const modifiers = [process.platform === 'darwin' ? 'meta' : 'control']
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    }, keyCode)
    try {
      await openSettings(page)
      assert.equal(await zoom().inputValue(), '1')
      await zoom().selectOption('1.1')
      await waitForScale(1.1)
      await press('+')
      await waitForScale(1.25)
      await page.waitForFunction(() => document.getElementById('opt-interface-zoom')?.value === '1.25')
      const reopened = await restart()
      app = reopened.app
      page = reopened.page
      await waitForScale(1.25)
      await openSettings(page)
      await page.waitForFunction(() => document.getElementById('opt-interface-zoom')?.value === '1.25')
      await press('0')
      await waitForScale(1)
      await page.waitForFunction(() => document.getElementById('opt-interface-zoom')?.value === '1')
    } finally {
      await openSettings(page)
      await zoom().selectOption('1')
      await waitForScale(1)
      await page.locator('#btn-close-settings').click()
    }
  })
  return page
}
