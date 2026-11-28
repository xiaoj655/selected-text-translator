import assert from 'node:assert/strict'
import { clickWord, openPastedText } from './reading-lookup.mjs'

const vocabularyPlan = (page) => page.evaluate(() => window.sttDesktop.tutor.vocabularyPlan())

export async function verifyVocabulary({ check, restart, configure, shot }) {
  await check('Vocabulary: offline session, restart and lookup history', async () => {
    const { page } = await restart()
    const initial = await vocabularyPlan(page)
    assert.equal(initial.newCount, 5)
    assert.equal(initial.dueCount, 0)
    assert.ok(initial.queue.every((item) => !item.fromHistory))

    if (await page.locator('#settings-panel').isVisible()) await page.locator('#btn-close-settings').click()
    await page.locator('#btn-tutor-workspace').click()
    await page.locator('#tutor-vocabulary-mode').click()
    await page.locator('#vocabulary-start').click()
    for (let index = 0; index < initial.queue.length; index++) {
      const { word } = initial.queue[index]
      await page.locator('#vocabulary-word').filter({ hasText: word }).waitFor()
      assert.equal(await page.locator('#vocabulary-word').textContent(), word)
      assert.equal(await page.locator('#vocabulary-meaning').isVisible(), false)
      await page.locator('#vocabulary-reveal').click()
      assert.equal(await page.locator('#vocabulary-meaning').textContent(), initial.queue[index].meaning)
      if (index === 0) await shot(page, 'vocabulary-first-word')
      const rating = index === 0 ? 'familiar' : 'known'
      await page.locator(`[data-vocabulary-rating="${rating}"]`).click()
    }
    await page.locator('#vocabulary-summary').waitFor()

    const { page: reopened } = await restart()
    const after = await vocabularyPlan(reopened)
    assert.equal(after.newCount, 5)
    assert.ok(after.nextReviewAt > Date.now(), 'the familiar card should still have a scheduled review')
    assert.ok(after.queue.every((item) => !initial.queue.some(({ word }) => word === item.word)))

    await configure(reopened)
    await reopened.locator('#input').fill('deploy')
    await reopened.locator('#btn-send').click()
    await reopened.waitForFunction(async () => {
      const [first] = (await window.sttDesktop.tutor.vocabularyPlan()).queue
      return first?.word === 'deploy' && first.fromHistory
    })

    await openPastedText(reopened, 'He was reluctant to admit that the plan had failed.')
    await clickWord(reopened, 'reluctant')
    await reopened.waitForFunction(async () => {
      const plan = await window.sttDesktop.tutor.vocabularyPlan()
      return plan.queue.some((item) => item.word === 'reluctant' && item.fromHistory)
    })
  })
}
