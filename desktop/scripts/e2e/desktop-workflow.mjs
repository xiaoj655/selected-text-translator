import assert from 'node:assert/strict'

const SOURCE = 'The supplier put off the launch because the packaging was delayed.'
const QUESTIONS = [
  {
    sentence: 'Maya put off the call until Friday.',
    prompt: 'What did Maya do about the call?',
    choices: ['She canceled it.', 'She postponed it until Friday.'],
    correctIndex: 1,
    hint: 'Read “put off the call” together, then look at “until Friday.”',
    explanation: '“Put off” means to postpone. “Until Friday” gives the new time.',
  },
  {
    sentence: 'We had to put off the picnic when it began raining.',
    prompt: 'What happened to the picnic when it started raining?',
    choices: ['It was postponed.', 'It went ahead in the rain.'],
    correctIndex: 0,
    hint: 'Look for the activity named after “put off.”',
    explanation: '“Put off the picnic” means to have the picnic at a later time.',
  },
]

async function paste(page, text) {
  await page.evaluate((value) => window.sttDesktop.copyText(value), text)
  const inputEl = page.locator('#input')
  await inputEl.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V')
  assert.equal(await inputEl.inputValue(), text)
  await page.waitForFunction((source) => {
    const entry = document.querySelector('.entry:last-child')
    return Boolean(entry?.querySelector('.bubble')?.textContent.includes(source)
      && /^(Done|From translation memory)/u.test(document.getElementById('statusbar').textContent))
  }, text)
}

async function clearHistory(page) {
  if (await page.locator('.entry').count()) {
    await page.locator('#btn-more').click()
    await page.locator('#btn-clear').click()
    await page.locator('#snackbar .snackbar-action').click()
    await page.locator('#snackbar-close').click()
  }
  await page.locator('#btn-clear-input').click()
}

export async function verifyDesktopWorkflow({ app, page, mock, check, shot }) {
  await check('version and native menu: show the installed app version, with no Electron menu', async () => {
    const metadata = await app.evaluate(({ app, Menu, BrowserWindow, globalShortcut }) => ({
      version: app.getVersion(),
      menuRoles: Menu.getApplicationMenu()?.items.map((item) => String(item.role).toLowerCase()) || [],
      visible: process.platform !== 'darwin' && BrowserWindow.getAllWindows().some((win) => win.isMenuBarVisible()),
      hotkey: globalShortcut.isRegistered('Alt+Shift+E'),
    }))
    if (process.platform === 'darwin') assert.ok(metadata.menuRoles.includes('editmenu'))
    else assert.deepEqual(metadata.menuRoles, [])
    assert.equal(metadata.visible, false)
    assert.equal(metadata.hotkey, false)
    await page.locator('#btn-more').click()
    assert.equal(await page.locator('#installed-version').textContent(), `v${metadata.version}`)
    assert.match(await page.locator('#btn-releases').textContent(), /View releases/u)
    await page.locator('#btn-more').click()
  })

  await check('main window zoom: plus, minus and reset while typing', async () => {
    const input = page.locator('#input')
    const press = (keyCode) => app.evaluate(({ BrowserWindow }, keyCode) => {
      const win = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/app/index.html'))
      win.focus()
      const modifiers = [process.platform === 'darwin' ? 'meta' : 'control']
      // DevTools keyboard events skip Electron's before-input-event.
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    }, keyCode)
    const ratio = () => page.evaluate(() => devicePixelRatio)
    const initial = await ratio()
    const originalText = await input.inputValue()
    await input.focus()
    try {
      await press('=')
      await page.waitForFunction((initial) => devicePixelRatio > initial, initial, { timeout: 3000 })
      const enlarged = await ratio()
      await press('+')
      await page.waitForFunction((enlarged) => devicePixelRatio > enlarged, enlarged, { timeout: 3000 })
      await press('-')
      await page.waitForFunction((enlarged) => Math.abs(devicePixelRatio - enlarged) < 0.001, enlarged, { timeout: 3000 })
      assert.equal(await input.inputValue(), originalText)
      assert.equal(await input.evaluate((el) => document.activeElement === el), true)
    } finally {
      await press('0')
      await page.waitForFunction((initial) => Math.abs(devicePixelRatio - initial) < 0.001, initial, { timeout: 3000 })
    }
  })

  await check('paste workspace: consecutive Ctrl+V submits once and replaces the previous source', async () => {
    const count = mock.requests.length
    try {
      await page.locator('#input').fill('手动输入的草稿')
      await new Promise((resolve) => setTimeout(resolve, 950))
      assert.equal(mock.requests.length, count, 'typing does not request translation by default')
      const first = '第一段需要翻译的中文。'
      const second = '第二段需要翻译的中文。'
      await paste(page, first)
      await paste(page, second)
      assert.deepEqual(mock.requests.slice(count).map(({ text }) => text), [first, second])
    } finally {
      await clearHistory(page)
    }
  })

  await check('request debug: opt in, inspect the outbound payload, copy, clear and disable', async () => {
    const debug = page.getByRole('dialog', { name: 'Request Debugger' })
    const record = debug.getByRole('checkbox', { name: 'Record requests' })
    const open = async () => {
      await page.locator('#btn-more').click()
      await page.getByRole('menuitem', { name: 'Request Debugger' }).click()
      await page.waitForFunction(() => !document.getElementById('debug-enabled').disabled)
    }
    const close = () => debug.getByRole('button', { name: 'Close request debugger' }).click()
    let outbound
    mock.setHandler(async ({ body, res, defaultResponse }) => {
      outbound = body
      await defaultResponse({ body, res })
    })
    try {
      await paste(page, '调试模式默认关闭。')
      await open()
      assert.equal(await record.isChecked(), false)
      assert.equal(await debug.locator('.debug-row').count(), 0)
      await record.check()
      await debug.getByText('Recording requests.').waitFor()
      await page.keyboard.press('Escape')
      await debug.waitFor({ state: 'hidden' })
      assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-more')
      assert.equal(await page.locator('#btn-more').getAttribute('data-recording-requests'), '')

      const source = '这条翻译用来核对调试请求。'
      await paste(page, source)
      await open()
      assert.equal(await debug.locator('.debug-row').count(), 1)
      assert.match(await debug.locator('#debug-url').textContent(), /^POST http:\/\/127\.0\.0\.1:\d+\/v1\/chat\/completions$/u)
      assert.match(await debug.locator('#debug-meta').textContent(), /Translation · HTTP 200/u)
      assert.deepEqual(JSON.parse(await debug.locator('#debug-body').textContent()), outbound)
      await debug.getByText('Request headers', { exact: true }).click()
      assert.match(await debug.locator('#debug-headers').textContent(), /content-type: application\/json/iu)
      assert.doesNotMatch(await debug.locator('#debug-headers').textContent(), /e2e-mock-key/u)
      await shot?.(page, 'main-request-debug')

      await debug.getByRole('button', { name: 'Copy selected request' }).click()
      await debug.getByText('Request copied.').waitFor()
      const clipboard = await page.evaluate(() => window.sttDesktop.readClipboard())
      assert.deepEqual(JSON.parse(clipboard).body, outbound)
      assert.doesNotMatch(clipboard, /e2e-mock-key/u)

      await debug.getByRole('button', { name: 'Clear', exact: true }).click()
      await debug.getByText('Request log cleared.').waitFor()
      assert.equal(await debug.locator('.debug-row').count(), 0)
      await record.uncheck()
      await debug.getByText('Recording is off. The request log was cleared.').waitFor()
    } finally {
      mock.resetHandler()
      await page.evaluate(() => window.sttDesktop.requestDebug.setEnabled(false))
      if (await debug.isVisible()) await close()
      await clearHistory(page)
    }
  })

  await check('English Coach: derives a lesson from a real lookup, preserves answers and schedules review', async () => {
    let lessonRequests = 0
    mock.setHandler(async ({ body, res, defaultResponse }) => {
      if (!body.messages?.[0]?.content?.includes('Create an English reading comprehension lesson')) {
        await defaultResponse({ body, res })
        return
      }
      const input = JSON.parse(body.messages.at(-1).content)
      assert.equal(input.sourceText, SOURCE)
      assert.equal(input.sourceKind, 'sentence')
      lessonRequests++
      const content = JSON.stringify({ topic: 'Putting off plans', questions: QUESTIONS })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content } }] }))
    })
    try {
      await paste(page, SOURCE)
      await shot?.(page, 'main-translation')
      await page.locator('#btn-tutor-workspace').click()
      await page.locator('#tutor-review-mode').click()
      await page.locator('#tutor-start').waitFor({ state: 'visible' })
      assert.match(await page.locator('#tutor-workspace').textContent(), /From your translation history/u)
      assert.equal(await page.locator('#translation-workspace').isVisible(), false)
      assert.equal(lessonRequests, 0)
      await page.evaluate(() => window.sttDesktop.requestDebug.setEnabled(true))
      await page.locator('#tutor-start').click()
      await page.locator('.tutor-choice').first().waitFor()
      const audit = await page.evaluate(() => window.sttDesktop.requestDebug.getState())
      assert.equal(audit.entries.length, 1)
      assert.equal(audit.entries[0].kind, 'tutor')
      assert.equal(audit.entries[0].status, 200)
      assert.match(JSON.parse(audit.entries[0].body).messages[0].content, /Create an English reading comprehension lesson/u)
      await shot?.(page, 'main-tutor-exercise')
      await page.locator('#tutor-hint').click()
      await page.locator('.tutor-choice').nth(1).click()
      assert.equal(await page.locator('#tutor-feedback').textContent(), 'Correct')
      await page.locator('#btn-translate-workspace').click()
      assert.equal(await page.locator('#input').inputValue(), SOURCE)
      await page.locator('#btn-tutor-workspace').click()
      await page.locator('#tutor-next').click()
      assert.equal(await page.locator('.tutor-sentence').textContent(), QUESTIONS[1].sentence)
      await page.locator('.tutor-choice').first().click()
      await page.locator('#tutor-next').click()
      await page.locator('#tutor-continue').waitFor({ state: 'visible' })
      assert.match(await page.locator('#tutor-workspace').textContent(), /after a hint or correction/u)
      await page.locator('#tutor-continue').click()
      await page.getByText('You’re all caught up').waitFor({ state: 'visible' })
      assert.equal(lessonRequests, 1)
    } finally {
      await page.evaluate(() => window.sttDesktop.requestDebug.setEnabled(false))
      mock.resetHandler()
      await page.locator('#btn-translate-workspace').click()
      await clearHistory(page)
    }
  })
}
