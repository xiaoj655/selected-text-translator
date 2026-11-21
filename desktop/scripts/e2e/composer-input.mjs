import assert from 'node:assert/strict'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function configure(page, { live = false, enter = false } = {}) {
  await page.evaluate(({ live, enter }) => {
    for (const [id, checked] of [['opt-live-translate', live], ['opt-enter', enter]]) {
      const control = document.getElementById(id)
      control.checked = checked
      control.dispatchEvent(new Event('change', { bubbles: true }))
    }
  }, { live, enter })
}

async function resetInput(page) {
  await configure(page)
  await page.locator('#btn-clear-input').evaluate((button) => button.click())
  await page.locator('#input').evaluate((input) => {
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }))
  })
}

async function compose(page, { text, start = false, end = false, composing = true }) {
  await page.locator('#input').evaluate((input, { text, start, end, composing }) => {
    if (start) input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    input.value = text
    if (end) input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: text }))
    input.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      data: text,
      inputType: composing ? 'insertCompositionText' : 'insertText',
      isComposing: composing,
    }))
  }, { text, start, end, composing })
}

async function pressKey(page, key, options = {}) {
  return page.locator('#input').evaluate((input, { key, options }) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
    input.dispatchEvent(event)
    return event.defaultPrevented
  }, { key, options })
}

async function waitForTranslation(page, text) {
  await page.waitForFunction((value) => {
    const entry = document.querySelector('.entry')
    const status = document.getElementById('statusbar')?.textContent || ''
    return Boolean(entry?.querySelector('.bubble')?.textContent.includes(value)
      && /完成/u.test(status) && !entry.querySelector('.is-loading'))
  }, text, { timeout: 15000 })
}

export async function verifyComposerInput({ app, page, mock, check }) {
  const original = await page.evaluate(() => ({
    live: document.getElementById('opt-live-translate').checked,
    enter: document.getElementById('opt-enter').checked,
  }))
  try {
    await check('IME: composing pauses live translation and commits only the final text once', async () => {
      await resetInput(page)
      await configure(page, { live: true })
      const before = mock.requests.length
      try {
        await compose(page, { text: 'shurufazhong', start: true })
        await delay(1100)
        assert.equal(mock.requests.length, before, 'unconfirmed IME text must not reach the model API')
        const finalText = '输入法确认后的完整文本'
        await compose(page, { text: finalText, end: true, composing: false })
        await waitForTranslation(page, finalText)
        await delay(1000)
        assert.equal(mock.requests.length, before + 1, 'compositionend and final input must share one debounce')
        assert.equal(mock.requests.at(-1).text, finalText, 'the API should receive only confirmed characters')
      } finally {
        await resetInput(page)
      }
    })

    await check('IME: compositionstart cancels an already scheduled live translation', async () => {
      await resetInput(page)
      await configure(page, { live: true })
      const before = mock.requests.length
      try {
        await page.locator('#input').fill('ime-pending-timer-probe')
        await page.locator('#input').evaluate((input) => {
          input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
        })
        await delay(1100)
        assert.equal(mock.requests.length, before, 'a debounce scheduled before composition must be cancelled')
      } finally {
        await resetInput(page)
      }
    })

    await check('IME: composing InputEvent is protected even without compositionstart', async () => {
      await resetInput(page)
      await configure(page, { live: true })
      const before = mock.requests.length
      try {
        await compose(page, { text: 'ime-input-event-probe' })
        await delay(1100)
        assert.equal(mock.requests.length, before, 'InputEvent.isComposing must prevent live submission')
      } finally {
        await resetInput(page)
      }
    })

    await check('IME: candidate Enter is untouched while ordinary Enter still submits', async () => {
      await resetInput(page)
      await configure(page, { enter: true })
      const before = mock.requests.length
      try {
        await compose(page, { text: 'ime-enter-confirm-probe', start: true })
        assert.equal(await pressKey(page, 'Enter', { isComposing: true }), false,
          'IME confirmation must retain its native default action')
        assert.equal(await pressKey(page, 'Enter'), false,
          'an active composition must also protect events without the native composing flag')
        await delay(200)
        assert.equal(mock.requests.length, before, 'confirming an IME candidate must not submit')
        const finalText = '输入法确认后手动翻译'
        await compose(page, { text: finalText, end: true, composing: false })
        assert.equal(await pressKey(page, 'Enter'), true, 'ordinary Enter should use the submit shortcut')
        await waitForTranslation(page, finalText)
        assert.equal(mock.requests.length, before + 1)
      } finally {
        await resetInput(page)
      }
    })

    await check('IME: Escape dismisses candidates without hiding the main window', async () => {
      await resetInput(page)
      await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('index.html'))
        window.show()
      })
      try {
        await compose(page, { text: 'ime-escape-probe', start: true })
        assert.equal(await pressKey(page, 'Escape', { isComposing: true }), false,
          'IME Escape should retain its native candidate-dismiss action')
        await delay(150)
        const visible = await app.evaluate(({ BrowserWindow }) => {
          return BrowserWindow.getAllWindows()
            .find((item) => item.webContents.getURL().includes('index.html')).isVisible()
        })
        assert.equal(visible, true, 'IME Escape must not hide the translation window')
      } finally {
        await resetInput(page)
        await app.evaluate(({ BrowserWindow }) => {
          BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('index.html')).show()
        })
      }
    })

    await check('manual submit: Ctrl+Enter and Cmd+Enter remain available', async () => {
      await resetInput(page)
      try {
        for (const modifier of ['ctrlKey', 'metaKey']) {
          const text = `ime-manual-${modifier}-probe`
          const before = mock.requests.length
          await page.locator('#input').fill(text)
          assert.equal(await pressKey(page, 'Enter', { [modifier]: true }), true)
          await waitForTranslation(page, text)
          assert.equal(mock.requests.length, before + 1, `${modifier} shortcut should submit exactly once`)
        }
      } finally {
        await resetInput(page)
      }
    })
  } finally {
    await resetInput(page)
    await configure(page, original)
  }
}
