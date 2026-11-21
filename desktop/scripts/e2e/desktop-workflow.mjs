import assert from 'node:assert/strict'

const SOURCE = 'The supplier put off the launch because the packaging was delayed.'
const QUESTIONS = [
  {
    sentence: 'Maya put off the call until Friday.',
    prompt: 'Maya 对通话作了什么安排？',
    choices: ['取消了通话', '把通话推迟到周五'],
    correctIndex: 1,
    hint: '连起来读 put off the call，再看 until Friday。',
    explanation: 'Put off 表示推迟；until Friday 给出了新的时间。',
  },
  {
    sentence: 'We had to put off the picnic when it began raining.',
    prompt: '下雨后，野餐怎么安排？',
    choices: ['推迟野餐', '冒雨继续野餐'],
    correctIndex: 0,
    hint: '找到 put off 后面的活动。',
    explanation: 'Put off the picnic 表示推迟野餐。',
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
      && /完成|翻译记忆/u.test(document.getElementById('statusbar').textContent))
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

export async function verifyDesktopWorkflow({ app, page, mock, check }) {
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
    assert.match(await page.locator('#btn-releases').textContent(), /查看发布版本/u)
    await page.locator('#btn-more').click()
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

  await check('AI teacher: derives a lesson from a real lookup, preserves answers and schedules review', async () => {
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
      const content = JSON.stringify({ topic: '理解推迟安排', questions: QUESTIONS })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content } }] }))
    })
    try {
      await paste(page, SOURCE)
      await page.locator('#btn-tutor-workspace').click()
      await page.locator('#tutor-start').waitFor({ state: 'visible' })
      assert.match(await page.locator('#tutor-workspace').textContent(), /来自查词记录/u)
      assert.equal(await page.locator('#translation-workspace').isVisible(), false)
      assert.equal(lessonRequests, 0)
      await page.locator('#tutor-start').click()
      await page.locator('#tutor-hint').click()
      await page.locator('.tutor-choice').nth(1).click()
      assert.match(await page.locator('#tutor-feedback').textContent(), /答对了/u)
      await page.locator('#btn-translate-workspace').click()
      assert.equal(await page.locator('#input').inputValue(), SOURCE)
      await page.locator('#btn-tutor-workspace').click()
      await page.locator('#tutor-next').click()
      assert.equal(await page.locator('.tutor-sentence').textContent(), QUESTIONS[1].sentence)
      await page.locator('.tutor-choice').first().click()
      await page.locator('#tutor-next').click()
      await page.locator('#tutor-continue').waitFor({ state: 'visible' })
      assert.match(await page.locator('#tutor-workspace').textContent(), /经过提示或订正/u)
      await page.locator('#tutor-continue').click()
      await page.getByText('暂时没有待练习的内容').waitFor({ state: 'visible' })
      assert.equal(lessonRequests, 1)
    } finally {
      mock.resetHandler()
      await page.locator('#btn-translate-workspace').click()
      await clearHistory(page)
    }
  })
}
