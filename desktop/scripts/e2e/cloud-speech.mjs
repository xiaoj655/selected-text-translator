import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const PREVIEW = 'Could you record the meeting? I need a record of what we decided.'
const ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'

export async function withSpeechCommands(page, run) {
  await page.evaluate(() => {
    const sendMessage = chrome.runtime.sendMessage
    window.speechCommands = []
    window.restoreSpeechCommands = () => { chrome.runtime.sendMessage = sendMessage }
    chrome.runtime.sendMessage = (message, callback) => {
      if (message.type !== 'SPEAK_TEXT' && message.type !== 'STOP_SPEECH') return sendMessage(message, callback)
      window.speechCommands.push(message)
      const response = { ok: true }
      callback?.(response)
      return Promise.resolve(response)
    }
  })
  try {
    await run(() => page.evaluate(() => window.speechCommands))
  } finally {
    await page.evaluate(() => {
      window.restoreSpeechCommands()
      delete window.restoreSpeechCommands
      delete window.speechCommands
    })
  }
}

async function installSpeechMock(app, key) {
  const samples = 12000
  const tone = Buffer.alloc(samples * 2)
  for (let index = 0; index < samples; index += 1) {
    const envelope = Math.min(index / 600, (samples - index - 1) / 600, 1)
    tone.writeInt16LE(Math.round(1200 * envelope * Math.sin(2 * Math.PI * 440 * index / 24000)), index * 2)
  }
  const chunks = [tone.subarray(0, samples), tone.subarray(samples)].map((chunk) => chunk.toString('base64'))
  await app.evaluate((_electron, { endpoint, authorization, chunks }) => {
    const probe = { originalFetch: globalThis.fetch, requests: [], hold: true, abortCount: 0 }
    globalThis.cloudSpeechProbe = probe
    globalThis.fetch = async (input, options = {}) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (url.href !== endpoint) {
        if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return probe.originalFetch(input, options)
        throw new Error('Cloud speech regression permits only the mocked provider and loopback requests.')
      }

      const headers = new Headers(options.headers)
      probe.requests.push({
        method: options.method,
        hasExpectedAuthorization: headers.get('Authorization') === authorization,
        sse: headers.get('X-DashScope-SSE'),
        body: JSON.parse(options.body),
      })
      if (probe.hold) {
        const signal = options.signal
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            probe.abortCount += 1
            reject(signal.reason)
          }, { once: true })
        })
      }

      const frames = chunks.map((data) => ({ output: { audio: { data }, finish_reason: null } }))
      frames.push({ output: { audio: { data: '' }, finish_reason: 'stop' } })
      const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
    }
  }, { endpoint: ENDPOINT, authorization: `Bearer ${key}`, chunks })
}

async function readSpeechMock(app) {
  return app.evaluate(() => ({
    requests: globalThis.cloudSpeechProbe.requests,
    abortCount: globalThis.cloudSpeechProbe.abortCount,
  }))
}

async function waitForSpeechMock(app, predicate, description) {
  const deadline = Date.now() + 5000
  do {
    const probe = await readSpeechMock(app)
    if (predicate(probe)) return probe
    await delay(25)
  } while (Date.now() < deadline)
  throw new Error(`Timed out waiting for ${description}`)
}

async function waitForSpeechStatus(page, expected) {
  await page.waitForFunction((text) => document.getElementById('speech-settings-status').textContent === text,
    expected, { timeout: 8000 })
}

export async function verifyCloudSpeech({ app, page, check }) {
  await check('cloud speech: opt in, cancel synthesis and play a mocked preview', async () => {
    const key = `sk-e2e-${randomUUID()}`
    const toggle = page.locator('#opt-cloud-speech')
    const keyInput = page.locator('#cfg-cloud-speech-key')
    const preview = page.locator('#btn-preview-speech')
    const save = page.locator('#btn-save-speech')
    await installSpeechMock(app, key)
    try {
      await page.locator('#btn-settings').click()
      await page.locator('.settings-nav').getByRole('link', { name: 'Reading', exact: true }).click()
      await page.waitForFunction(() => Boolean(document.getElementById('cfg-api-key').value))
      assert.equal(await toggle.isChecked(), false)
      assert.equal(await keyInput.getAttribute('type'), 'password')
      await toggle.check()
      await keyInput.fill(key)
      assert.equal((await page.evaluate(() => chrome.storage.sync.get({ desktop_tts_cloud: false }))).desktop_tts_cloud,
        false, 'editing the form must not enable cloud speech before saving')
      assert.equal((await readSpeechMock(app)).requests.length, 0)
      await save.click()
      await waitForSpeechStatus(page, 'Speech settings saved.')
      assert.equal((await readSpeechMock(app)).requests.length, 0, 'saving must not synthesize audio')
      await page.locator('#btn-close-settings').click()
      await toggle.evaluate((control) => { control.checked = false })
      await keyInput.evaluate((input) => { input.value = '' })
      await page.locator('#btn-settings').click()
      await page.locator('.settings-nav').getByRole('link', { name: 'Reading', exact: true }).click()
      await page.waitForFunction(() => document.getElementById('opt-cloud-speech').checked)
      assert.ok((await keyInput.inputValue()) === key, 'the cloud credential must persist in the settings form')

      await page.evaluate(() => {
        window.cloudSpeechEvents = []
        window.captureCloudSpeech = (message) => {
          if (message.type === 'SPEECH_EVENT') window.cloudSpeechEvents.push(message.payload.status)
        }
        chrome.runtime.onMessage.addListener(window.captureCloudSpeech)
      })
      await page.evaluate(() => window.sttDesktop.requestDebug.setEnabled(true))
      await preview.click()
      const pending = await waitForSpeechMock(app, ({ requests }) => requests.length >= 1, 'a speech request')
      assert.deepEqual(pending.requests, [{
        method: 'POST', hasExpectedAuthorization: true, sse: 'enable',
        body: { model: 'qwen3-tts-flash', input: { text: PREVIEW, voice: 'Jennifer', language_type: 'English' } },
      }])
      assert.equal(await preview.getAttribute('aria-pressed'), 'true')
      await preview.click()
      await waitForSpeechMock(app, ({ abortCount }) => abortCount === 1, 'the request to abort')
      await waitForSpeechStatus(page, 'Playback stopped.')
      assert.equal(await preview.getAttribute('aria-pressed'), 'false')
      await page.waitForFunction(() => window.cloudSpeechEvents.includes('cancelled'))
      assert.deepEqual(await page.evaluate(() => window.cloudSpeechEvents.splice(0)), ['cancelled'])

      await app.evaluate(() => { globalThis.cloudSpeechProbe.hold = false })
      await preview.click()
      await waitForSpeechStatus(page, 'Playback finished.')
      assert.deepEqual(await page.evaluate(() => window.cloudSpeechEvents), ['start', 'end'])
      assert.equal(await preview.getAttribute('aria-pressed'), 'false')
      const { entries } = await page.evaluate(() => window.sttDesktop.requestDebug.getState())
      assert.deepEqual(entries.map(({ kind, outcome, status }) => ({ kind, outcome, status })), [
        { kind: 'cloud-speech', outcome: 'response', status: 200 },
        { kind: 'cloud-speech', outcome: 'aborted', status: null },
      ])
      assert.deepEqual(JSON.parse(entries[0].body), pending.requests[0].body)
      assert.equal(entries[0].headers.authorization, '[redacted]')

      await toggle.uncheck()
      await keyInput.clear()
      await save.click()
      await waitForSpeechStatus(page, 'Speech settings saved.')
      assert.deepEqual(await page.evaluate(() => chrome.storage.sync.get(['desktop_tts_cloud', 'desktop_tts_api_key'])),
        { desktop_tts_cloud: false, desktop_tts_api_key: '' })
      assert.equal((await readSpeechMock(app)).requests.length, 2)
    } finally {
      await preview.evaluate((button) => { if (button.getAttribute('aria-pressed') === 'true') button.click() })
      await page.evaluate(async () => {
        await window.sttDesktop.requestDebug.setEnabled(false)
        if (window.captureCloudSpeech) chrome.runtime.onMessage.removeListener(window.captureCloudSpeech)
        delete window.captureCloudSpeech
        delete window.cloudSpeechEvents
        document.getElementById('btn-close-settings').click()
        await chrome.storage.sync.remove(['desktop_tts_cloud', 'desktop_tts_api_key'])
      })
      await app.evaluate(() => {
        globalThis.fetch = globalThis.cloudSpeechProbe.originalFetch
        delete globalThis.cloudSpeechProbe
      })
    }
  })
}
