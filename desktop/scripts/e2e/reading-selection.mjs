import assert from 'node:assert/strict'
import { openPastedText, withState } from './reading-lookup.mjs'

const PASSAGE = 'The editor takes careful notes while reviewing the proposed changes, and the team confirms the result.'

function center(rect) {
  return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 }
}

async function drag(page, origin, steps) {
  await page.mouse.move(origin.x, origin.y)
  await page.mouse.down()
  try {
    for (const [point, text] of steps) {
      await page.mouse.move(point.x, point.y, { steps: 6 })
      assert.equal(await page.evaluate(() => window.getSelection().toString()), text)
    }
  } finally {
    await page.mouse.up()
  }
}

export async function verifyReadingSelection({ page, check }) {
  await check('article selection: line-end whitespace and cross-line drag in both directions', async () => {
    await withState(page, async () => {
      await openPastedText(page, PASSAGE)
      const material = page.locator('.reading-preview[data-reading-selectable]').first()
      const originalStyle = await material.getAttribute('style')
      await material.evaluate((node) => {
        node.style.fontFamily = 'monospace'
        node.style.inlineSize = '35ch'
      })
      try {
        const points = () => material.evaluate(async (node) => {
          const { rangeForOffsets } = await import(new URL('./reading-selection.js', location.href))
          const word = (text) => {
            const start = node.textContent.indexOf(text)
            return rangeForOffsets(node, start, start + text.length).getBoundingClientRect().toJSON()
          }
          return { first: word('editor'), last: word('notes'), next: word('while'), right: node.getBoundingClientRect().right }
        })
        const trailing = ({ last, right }) => ({ x: right - 2, y: center(last).y })
        const firstLine = 'editor takes careful notes'
        const crossLine = `${firstLine} while`
        const forward = await points()
        assert.equal(forward.first.top, forward.last.top)
        assert.ok(forward.next.top > forward.last.bottom, 'while must wrap to the next line')
        assert.ok(trailing(forward).x > forward.last.right + 2, 'the endpoint must be in trailing whitespace')
        await drag(page, center(forward.first), [
          [trailing(forward), firstLine],
          [center(forward.next), crossLine],
          [trailing(forward), firstLine],
        ])
        const lookup = page.locator('#reading-lookup-text')
        await lookup.waitFor({ state: 'visible' })
        assert.equal(await lookup.textContent(), firstLine)
        await page.locator('#reading-lookup-close').click()

        const backward = await points()
        await drag(page, center(backward.next), [
          [trailing(backward), 'notes while'],
          [center(backward.first), crossLine],
        ])
        await lookup.waitFor({ state: 'visible' })
        assert.equal(await lookup.textContent(), crossLine)
      } finally {
        await material.evaluate((node, style) => {
          if (style === null) node.removeAttribute('style')
          else node.setAttribute('style', style)
        }, originalStyle)
      }
    })
  })
}
