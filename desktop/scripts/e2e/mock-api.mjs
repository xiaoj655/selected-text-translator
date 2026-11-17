import { createServer } from 'node:http'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function lastUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const content = messages.at(-1)?.content
  return typeof content === 'string' ? content : ''
}

export function createMockApi({ translationFor = (text) => `译:${text}`, lexicalFor = () => null } = {}) {
  let customHandler = null
  const requests = []

  async function defaultResponse({ body, res }) {
    const text = lastUserText(body)
    const translation = translationFor(text)
    if (body?.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      for (const char of [...translation]) {
        if (res.destroyed) return
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: char } }] })}\n\n`)
        await delay(10)
      }
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    const content = JSON.stringify({ translation, ...(lexicalFor(text) || {}) })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content } }] }))
  }

  const server = createServer(async (req, res) => {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
      requests.push({ model: body.model, stream: Boolean(body.stream), text: lastUserText(body) })
      if (customHandler) await customHandler({ body, res, defaultResponse })
      else await defaultResponse({ body, res })
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end('{"error":"mock failure"}')
      }
    }
  })

  return {
    async listen() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      return `http://127.0.0.1:${server.address().port}/v1`
    },
    setHandler(handler) {
      customHandler = handler
    },
    resetHandler() {
      customHandler = null
    },
    requests,
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
