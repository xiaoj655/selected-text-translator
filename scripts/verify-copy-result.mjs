import assert from 'node:assert/strict'
import { join } from 'node:path'

export async function verifyCopyResult({
  worker, context, extensionId, origin, selectText, errors, artifactPath,
}) {
  await worker.evaluate(async () => {
    await chrome.storage.sync.set({ model: 'test-generic', reading_mode: 'guide' })
  })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  const cdp = await context.newCDPSession(page)
  const worlds = new Map()
  cdp.on('Runtime.executionContextCreated', ({ context }) => worlds.set(context.id, context))
  cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) => worlds.delete(executionContextId))
  cdp.on('Runtime.executionContextsCleared', () => worlds.clear())
  await cdp.send('Runtime.enable')
  try {
    await page.goto(`${origin}/copy`)
    await page.locator('#selected-reading-assistant').waitFor({ state: 'attached' })
    await page.bringToFront()

    // The page's main world cannot replace the content script's Clipboard wrapper.
    // Locate the actual extension world so failure/HTTP fallback stay test-only.
    let contentWorldId
    for (const world of worlds.values()) {
      if (world.auxData?.isDefault) continue
      const result = await cdp.send('Runtime.evaluate', {
        contextId: world.id,
        expression: 'typeof chrome !== "undefined" && chrome.runtime?.id',
        returnByValue: true,
      })
      if (result.result.value === extensionId) {
        contentWorldId = world.id
        break
      }
    }
    assert.ok(contentWorldId, 'The extension content script has an isolated execution context')
    async function inContentWorld(fn) {
      const result = await cdp.send('Runtime.callFunctionOn', {
        executionContextId: contentWorldId,
        functionDeclaration: fn.toString(),
        returnByValue: true,
        awaitPromise: true,
      })
      assert.equal(result.exceptionDetails, undefined, 'Content-world test setup succeeded')
      return result.result.value
    }
    async function assertCopied(expected) {
      await page.getByRole('button', { name: '已复制', exact: true }).waitFor()
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expected)
      assert.equal(await page.locator('.stt-copy-status').textContent(), '已复制到剪贴板')
    }
    async function assertIdle() {
      assert.equal(await page.locator('.stt-copy').textContent(), '复制')
      assert.equal(await page.locator('.stt-copy-status').textContent(), '')
    }

    await selectText('reluctant', '#sentence', 0, page)
    await page.locator('.stt-trigger').click()
    await page.locator('.stt-hint').first().waitFor()
    assert.equal(await page.locator('.stt-copy').count(), 0, 'Hidden answers cannot be copied')
    await page.locator('.stt-next-hint').click()
    await page.locator('.stt-next-hint').click()
    assert.equal(await page.locator('.stt-next-hint').count(), 0)
    assert.equal(await page.locator('.stt-reveal').evaluate((el) => el.classList.contains('stt-button')), true)
    await page.locator('.stt-reveal').click()
    const meaning = 'Here, reluctant means hesitant or unwilling to do something.'
    assert.equal(await page.locator('.stt-copy').getAttribute('command'), '--copy')
    assert.equal(await page.locator('.stt-copy').getAttribute('commandfor'), 'stt-copy-result')
    await page.locator('.stt-copy').click()
    await assertCopied(meaning)
    await page.screenshot({ animations: 'disabled', path: join(artifactPath, 'reading-answer.png') })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.locator('.stt-card').screenshot({ animations: 'disabled', path: join(artifactPath, 'reading-answer-dark.png') })
    assert.equal(await page.locator('.stt-card').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(33, 33, 33)')
    await page.emulateMedia({ colorScheme: 'light' })
    await page.waitForFunction(() => {
      const root = document.getElementById('selected-reading-assistant').shadowRoot
      return root.querySelector('.stt-copy').textContent === '复制'
        && root.querySelector('.stt-copy-status').textContent === ''
    }, null, { timeout: 5000 })

    await page.getByRole('button', { name: '翻译', exact: true }).click()
    await page.locator('.stt-copy').waitFor()
    const translation = '不情愿的；犹豫的'
    assert.equal(await page.locator('.stt-card-block--translation').textContent(), translation)
    await page.locator('.stt-copy').click()
    await assertCopied(translation)
    await page.locator('.stt-card').screenshot({ animations: 'disabled', path: join(artifactPath, 'reading-translation.png') })

    // Use the mouse so Chrome's retargeted Shadow DOM selection is exercised.
    const translationTextRect = await page.locator('.stt-card-block--translation').evaluate((el) => {
      const range = document.createRange()
      range.selectNodeContents(el)
      const rect = range.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    })
    const selectionY = translationTextRect.y + translationTextRect.height / 2
    await page.mouse.move(translationTextRect.x + 1, selectionY)
    await page.mouse.down()
    await page.mouse.move(translationTextRect.x + translationTextRect.width - 1, selectionY, { steps: 12 })
    await page.mouse.up()
    const selectedTranslation = await page.evaluate(() => window.getSelection().toString())
    assert.ok(selectedTranslation.length > 0 && translation.includes(selectedTranslation), 'Result text can be selected with the mouse')
    assert.equal(await page.locator('.stt-card').count(), 1, 'Selecting result text keeps the card open')
    assert.equal(await page.locator('.stt-source-text').textContent(), 'reluctant', 'Result selection keeps the original lookup')

    await inContentWorld(() => {
      globalThis.__sttCopyTest = {
        clipboardDescriptor: Object.getOwnPropertyDescriptor(navigator, 'clipboard'),
        execCommand: document.execCommand,
      }
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    })
    await page.locator('.stt-copy').focus()
    const originalSelection = await page.evaluate(() => window.getSelection().toString())
    await page.locator('.stt-copy').click()
    await assertCopied(translation)
    assert.equal(await page.locator('.stt-copy-field').count(), 0)
    assert.equal(await page.evaluate(() => window.getSelection().toString()), originalSelection)
    assert.equal(await page.locator('.stt-copy').evaluate((el) => el.getRootNode().activeElement === el), true)

    await inContentWorld(() => { document.execCommand = () => false })
    await page.locator('.stt-copy').click()
    await page.getByRole('button', { name: '重新复制', exact: true }).waitFor()
    assert.equal(await page.locator('.stt-copy-status').textContent(), '复制失败，请选择结果文字手动复制。')
    assert.equal(await page.locator('.stt-copy-field').count(), 0)
    await page.locator('.stt-card').screenshot({ animations: 'disabled', path: join(artifactPath, 'reading-copy-error.png') })
    await inContentWorld(() => { document.execCommand = globalThis.__sttCopyTest.execCommand })
    await page.locator('.stt-copy').click()
    await assertCopied(translation)

    await inContentWorld(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: () => new Promise((resolve) => { globalThis.__sttCopyTest.release = resolve }) },
      })
    })
    await page.locator('.stt-copy').click()
    assert.equal(await inContentWorld(() => typeof globalThis.__sttCopyTest.release), 'function')
    await page.getByRole('button', { name: '引导理解', exact: true }).click()
    await page.locator('.stt-meaning').waitFor()
    await inContentWorld(() => { globalThis.__sttCopyTest.release() })
    await assertIdle()

    await page.locator('.stt-copy').click()
    await selectText('record', '#repeated', 1, page)
    await page.locator('.stt-trigger').click()
    await page.locator('.stt-hint').first().waitFor()
    await page.locator('.stt-reveal').click()
    await inContentWorld(() => { globalThis.__sttCopyTest.release() })
    await assertIdle()
    assert.equal(await page.locator('.stt-source-text').textContent(), 'record')
    assert.equal(await page.locator('.stt-meaning').textContent(), 'An album or recording of music.')
  } finally {
    await cdp.detach()
    await page.close()
  }
}
