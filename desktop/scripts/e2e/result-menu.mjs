import assert from 'node:assert/strict'

async function setLiveTranslate(page, checked) {
  await page.locator('#opt-live-translate').evaluate((control, value) => {
    control.checked = value
    control.dispatchEvent(new Event('change', { bubbles: true }))
  }, checked)
}

async function assertMenuClickable(page) {
  const metrics = await page.locator('.entry .action-menu').evaluate((menu) => {
    const rect = menu.getBoundingClientRect()
    return {
      top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left,
      width: innerWidth, height: innerHeight,
      buttons: [...menu.querySelectorAll('button')].map((button) => {
        const bounds = button.getBoundingClientRect()
        const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
        return { label: button.textContent, clickable: Boolean(hit && button.contains(hit)) }
      }),
    }
  })
  assert.ok(metrics.left >= 0 && metrics.top >= 0, 'the open menu must stay inside the viewport origin')
  assert.ok(metrics.right <= metrics.width && metrics.bottom <= metrics.height,
    'the open menu must stay inside the viewport edges')
  assert.ok(metrics.buttons.length >= 2, 'the completed result must expose its menu actions')
  for (const button of metrics.buttons) {
    assert.equal(button.clickable, true, `the center of menu action ${button.label} must receive pointer events`)
  }
}

async function assertMenuClosed(page) {
  await page.waitForFunction(() => document.querySelector('.entry .action-menu')?.hidden === true)
  assert.equal(await page.locator('.entry .action-more').getAttribute('aria-expanded'), 'false')
}

export async function verifyResultMenu({ app, page, mock, shot }) {
  const wasLive = await page.locator('#opt-live-translate').isChecked()
  const bounds = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('index.html'))
    const previous = window.getBounds()
    window.setContentSize(620, 500)
    window.show()
    return previous
  })
  const text = 'menu-short-viewport-probe'
  const requestStart = mock.requests.length
  try {
    await setLiveTranslate(page, false)
    await page.locator('#input').fill(text)
    await page.locator('#btn-send').click()
    await page.waitForFunction((value) => {
      return document.querySelector('.entry .bubble')?.textContent.includes(value)
        && document.querySelector('.entry .result-label')?.textContent === 'Translation'
    }, text, { timeout: 15000 })
    await page.waitForFunction(() => innerWidth === 620 && innerHeight === 500)
    await page.locator('.entry .action-more').click()
    await page.locator('.entry .action-menu').waitFor({ state: 'visible' })
    assert.equal(await page.locator('.entry .action-more').getAttribute('aria-expanded'), 'true')
    await assertMenuClickable(page)
    await shot(page, 'main-actions-small-window')

    await page.getByRole('button', { name: 'Copy source text', exact: true }).focus()
    await page.keyboard.press('Escape')
    await assertMenuClosed(page)
    assert.equal(await page.locator('.entry .action-more').evaluate((button) => document.activeElement === button), true,
      'closing the popover from a focused menu action must restore focus to its trigger')
    const visible = await app.evaluate(({ BrowserWindow }) => {
      return BrowserWindow.getAllWindows()
        .find((item) => item.webContents.getURL().includes('index.html')).isVisible()
    })
    assert.equal(visible, true, 'Escape must dismiss the result menu without hiding the main window')
    await page.keyboard.press('Escape')
    const hidden = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('index.html'))
      const value = !window.isVisible()
      window.show()
      return value
    })
    assert.equal(hidden, true, 'a second Escape should retain the normal hide-window shortcut')

    await page.locator('.entry .action-more').click()
    await page.locator('.entry .action-menu').waitFor({ state: 'visible' })
    await page.locator('#input').click({ position: { x: 5, y: 5 } })
    await assertMenuClosed(page)

    await page.locator('.entry .action-more').click()
    await page.locator('.entry .action-menu').waitFor({ state: 'visible' })
    await assertMenuClickable(page)
    await page.getByRole('button', { name: 'Regenerate', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.entry .result-label')?.textContent === 'Translation')
    assert.equal(mock.requests.slice(requestStart).filter((request) => request.text === text).length, 2,
      'a real pointer click must regenerate the result through one fresh API request')
    await assertMenuClosed(page)

    await page.locator('.entry .action-more').click()
    await page.locator('.entry .action-menu').waitFor({ state: 'visible' })
    await page.keyboard.press('Control+h')
    await assertMenuClosed(page)
    await page.locator('#sidebar').waitFor({ state: 'visible' })
    assert.equal(await page.locator('#history-search').evaluate((input) => document.activeElement === input), true,
      'the history shortcut must transfer focus out of the result popover')
    await page.locator('#history-search').fill(text)
    assert.equal(await page.locator('.history-item', { hasText: text }).count(), 1,
      'history search must remain usable after dismissing the result popover')
    await page.locator('#history-search').fill('')
    await page.keyboard.press('Escape')
    await page.locator('#sidebar').waitFor({ state: 'hidden' })

    await page.locator('.entry .action-more').click()
    await page.locator('.entry .action-menu').waitFor({ state: 'visible' })
    await page.keyboard.press('Control+k')
    await assertMenuClosed(page)
    assert.equal(await page.locator('#input').evaluate((input) => document.activeElement === input), true,
      'the composer shortcut must close the result popover and focus the input')
  } finally {
    const more = page.locator('.entry .action-more')
    if (await more.count()) {
      await more.evaluate((button) => {
        if (button.getAttribute('aria-expanded') === 'true') button.click()
      })
    }
    await page.locator('#history-search').evaluate((input) => {
      input.value = ''
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await page.locator('#btn-close-sidebar').evaluate((button) => button.click())
    await setLiveTranslate(page, wasLive)
    await app.evaluate(({ BrowserWindow }, previous) => {
      BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('index.html')).setBounds(previous)
    }, bounds)
  }
}
