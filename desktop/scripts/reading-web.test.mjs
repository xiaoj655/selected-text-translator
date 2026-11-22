import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { importReadingPage } from '../src/reading-web.js'
import { createStorage, setCrypto } from '../src/storage.js'

const URL = 'https://www.paulgraham.com/think.html'
const KEY = 'iqs-mock-key'
const TEXT = 'There are some kinds of work that you cannot do well without thinking differently from your peers.\n\nIndependent ideas can reveal assumptions that other people take for granted.'
const DATA = { statusCode: 200, text: TEXT, metadata: { title: 'How to Think for Yourself' } }

test('IQS import accepts Markdown links and sends the configured key only to the fixed endpoint', async () => {
  const article = await importReadingPage(`[How to Think for Yourself](${URL})`, {
    apiKey: ` ${KEY} `,
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://cloud-iqs.aliyuncs.com/readpage/scrape')
      assert.equal(init.method, 'POST')
      assert.equal(init.headers['X-API-Key'], KEY)
      assert.equal(init.credentials, 'omit')
      assert.equal(init.redirect, 'error')
      assert.deepEqual(JSON.parse(init.body), {
        url: URL, maxAge: 0, formats: ['text'], readability: { readabilityMode: 'article' },
      })
      return Response.json({ data: DATA })
    },
  })
  assert.equal(article.title, DATA.metadata.title)
  assert.equal(article.url, URL)
  assert.equal(article.text, TEXT)
  assert.equal(article.kind, 'web_article')
  assert.equal(article.textTruncated, false)
  assert.ok(!JSON.stringify(article).includes(KEY))
})

test('IQS validates links before sending a paid request', async () => {
  for (const url of ['', 'not a URL', 'http://site.com', 'https://127.0.0.1', 'https://site.local', 'https://user:pass@site.com']) {
    await assert.rejects(importReadingPage(url, {
      apiKey: KEY,
      fetchImpl: () => assert.fail('Invalid URL reached the cloud service'),
    }), /Enter a public HTTPS article link/u)
  }
})

test('IQS failures have useful messages and do not expose service-supplied credentials', async () => {
  const cases = [
    [403, { errorCode: 'InvalidAccessKeyId.NotFound', errorMessage: KEY }, /rejected the IQS API key/u],
    [403, { errorCode: 'Retrieval.NotActivate' }, /Enable webpage parsing/u],
    [403, { errorCode: 'ReadPage.SecurityRestrict' }, /site’s access rules/u],
    [429, {}, /too many requests/u],
    [200, { errorCode: 'ReadPage.RequestTimeout' }, /timed out/u],
    [200, { data: { ...DATA, statusCode: 403 } }, /couldn’t open the target page/u],
    [200, { data: { ...DATA, errorMessage: KEY } }, /couldn’t open the target page/u],
    [200, { data: { ...DATA, text: '' } }, /Couldn’t find article text/u],
    [200, { errorCode: 'Unknown', errorMessage: KEY }, /webpage parsing failed/u],
  ]
  for (const [status, response, expected] of cases) {
    await assert.rejects(importReadingPage(URL, {
      apiKey: KEY, fetchImpl: async () => Response.json(response, { status }),
    }), (error) => {
      assert.match(error.message, expected)
      assert.ok(!error.message.includes(KEY))
      return true
    })
  }
  await assert.rejects(importReadingPage(URL, {
    apiKey: KEY, fetchImpl: async () => { throw new Error(KEY) },
  }), /Couldn’t connect to Alibaba Cloud/u)
  await assert.rejects(importReadingPage(URL, {
    apiKey: KEY, fetchImpl: async () => new Response('<html>not JSON</html>'),
  }), /unreadable response/u)
})

test('IQS bounds article text and response size', async () => {
  const article = await importReadingPage(URL, {
    apiKey: KEY, fetchImpl: async () => Response.json({ data: { ...DATA, text: TEXT.repeat(100) } }),
  })
  assert.equal(article.text.length, 12000)
  assert.equal(article.textTruncated, true)
  await assert.rejects(importReadingPage(URL, {
    apiKey: KEY, fetchImpl: async () => new Response('a'.repeat(2 * 1024 * 1024 + 1)),
  }), /response is too large/u)
})

test('the saved IQS credential uses the existing encryption and survives storage reload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stt-iqs-storage-'))
  setCrypto({
    encrypt: (value) => Buffer.from(value).toString('base64'),
    decrypt: (value) => Buffer.from(value, 'base64').toString(),
  })
  try {
    await createStorage(dir).sync.set({ desktop_iqs_api_key: KEY })
    const disk = readFileSync(join(dir, 'sync.json'), 'utf8')
    assert.ok(!disk.includes(KEY))
    assert.ok(JSON.parse(disk).desktop_iqs_api_key.startsWith('enc:v1:'))
    assert.equal((await createStorage(dir).sync.get('desktop_iqs_api_key')).desktop_iqs_api_key, KEY)
  } finally {
    setCrypto(null)
    rmSync(dir, { recursive: true, force: true })
  }
})
