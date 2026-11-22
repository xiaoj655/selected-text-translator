import assert from 'node:assert/strict'
import test from 'node:test'
import { parseHTML } from 'linkedom'
import { normalizeReadingContent, plainReadingContent } from '../src/reading-content.js'

const baseUrl = 'https://publisher.com/articles/reading'

function domText(html) {
  const { document } = parseHTML('<html><body></body></html>')
  document.body.innerHTML = html
  return document.body.textContent
}

test('rich content preserves structural formatting, code and all text with matching DOM offsets', () => {
  const content = normalizeReadingContent(`<h2>A heading</h2><p>${'An inline <strong>important</strong> idea. '.repeat(800)}</p>
    <blockquote>A quote.</blockquote><ol start="3"><li>One</li><li>Two</li></ol>
    <table><tbody><tr><th>Key</th><td>Value</td></tr></tbody></table>
    <pre><code>  const value = 1;\n    keepIndent();</code></pre><p>The final paragraph.</p>`, { baseUrl })
  assert.ok(content.text.length > 12000)
  assert.equal(domText(content.html), content.text)
  assert.match(content.text, /A heading\n\n/u)
  assert.match(content.text, /Key\tValue/u)
  assert.match(content.text, /  const value = 1;\n    keepIndent\(\);/u)
  assert.match(content.text, /The final paragraph\.$/u)
  assert.match(content.html, /<ol start="3">/u)
  assert.match(content.html, /<strong>important<\/strong>/u)
})

test('source markup cannot execute scripts, apply styles, clobber app IDs or load unsafe URLs', () => {
  const content = normalizeReadingContent(`<p id="cfg-api-key" class="app" style="position:fixed" onclick="bad()">Text
    <a href="javascript:bad()">bad link</a><a href="../more">good link</a></p>
    <script>secret()</script><style>body{display:none}</style><svg onload="bad()"><script>nested()</script><rect width="10" height="10"/></svg>
    <math><mtext><img src="https://tracker.com/a" onerror="bad()"></mtext></math>
    <img src="http://publisher.com/a"><img src="https://127.0.0.1/a"><img src="https://site.local/a">
    <form><input name="apiKey"><button formaction="https://tracker.com">Submit</button></form>`, { baseUrl })
  assert.doesNotMatch(content.html, /onclick|onerror|javascript:|<script|<style|<svg|<math|<form|<input|<button|\bid=|\bclass=|\bstyle=|https:\/\/127/u)
  assert.doesNotMatch(content.text, /secret\(\)|nested\(\)|display:none/u)
  assert.match(content.html, /href="https:\/\/publisher.com\/more"/u)
  assert.match(content.html, /src="data:image\/svg\+xml;base64,/u)
})

test('images and native videos use checked media URLs while embeds become original-page links', () => {
  const content = normalizeReadingContent(`<figure><img src="placeholder.gif" data-src="/diagram.png" alt="Diagram" srcset="/large.png 2x" onerror="bad()"><figcaption>Caption.</figcaption></figure>
    <video src="/clip.mp4" poster="/poster.jpg" autoplay onplay="bad()"><source src="/alternate.webm" type="video/webm"></video>
    <iframe src="https://www.youtube.com/embed/example" srcdoc="<script>bad()</script>"></iframe>`, { baseUrl })
  assert.match(content.html, /src="stt-media:\/\/asset\/\?url=https%3A%2F%2Fpublisher.com%2Fdiagram.png"/u)
  assert.match(content.html, /<figcaption>Caption\.<\/figcaption>/u)
  assert.match(content.html, /<video[^>]*controls/u)
  assert.match(content.html, /<video[^>]*data-reading-video/u)
  assert.match(content.html, /<source[^>]*stt-media/u)
  assert.match(content.html, /data-reading-media-fallback="video"/u)
  assert.doesNotMatch(content.html, /<iframe|srcdoc|autoplay|onplay|onerror|srcset|data-src/u)
  assert.equal(domText(content.html), content.text)
})

test('plain fallback is escaped without losing long text or paragraph breaks', () => {
  const text = `${'<script>literal</script>\n\n'.repeat(800)}Final text.`
  const content = plainReadingContent(text)
  assert.equal(content.text, text)
  assert.equal(domText(content.html), text)
  assert.doesNotMatch(content.html, /<script>/u)
})

test('empty lazy image attributes do not shadow a valid image source', () => {
  const content = normalizeReadingContent('<p>Actual photo <img data-src="" data-original="  " src="https://cdn.publisher.com/photo.png"></p>', { baseUrl })
  assert.match(content.html, /url=https%3A%2F%2Fcdn.publisher.com%2Fphoto.png/u)
  assert.doesNotMatch(content.html, /url=https%3A%2F%2Fpublisher.com%2Farticles/u)
})

test('adjacent and nested blocks use at most two boundary newlines without changing preformatted whitespace', () => {
  const content = normalizeReadingContent('  <div><p>First <em>inline</em> paragraph.</p> \n <p>Second paragraph.</p><figure><figcaption>A caption.</figcaption></figure><ul><li>One</li><li>Two</li></ul></div>  ', { baseUrl })
  assert.equal(content.text, 'First inline paragraph.\n\nSecond paragraph.\n\nA caption.\n\nOne\n\nTwo')
  assert.equal(domText(content.html), content.text)
  const pre = normalizeReadingContent('<pre><code>  first\n\n\n    second\n</code></pre><p>After.</p>', { baseUrl })
  assert.equal(pre.text, '  first\n\n\n    second\n\nAfter.')
  assert.equal(domText(pre.html), pre.text)
})

test('malformed table content follows browser HTML5 ordering before text offsets are computed', () => {
  const content = normalizeReadingContent('<table><p>First</p><tr><td>Second</td></tr>Third</table><p>Last</p>', { baseUrl })
  assert.equal(content.text, 'First\n\nThird\n\nSecond\n\nLast')
  assert.equal(domText(content.html), content.text)
})

test('inline SVG diagrams become sanitized static images without accepting source data URLs', () => {
  const content = normalizeReadingContent(`<p>A diagram follows.</p><svg viewBox="0 0 100 50" onload="bad()"><title>A useful diagram</title>
    <defs><linearGradient id="paint"><stop offset="0" stop-color="red"/></linearGradient></defs>
    <rect width="100" height="50" fill="url(#paint)"/><text x="5" y="20">Keep label</text>
    <script>bad()</script><foreignObject><div>unsafe</div></foreignObject><image href="https://tracker.com/image"/>
    </svg><img alt="Untrusted source data" src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImJhZCgpIj48L3N2Zz4=">`, { baseUrl })
  const { document } = parseHTML('<html><body></body></html>')
  document.body.innerHTML = content.html
  const image = document.body.querySelector('img')
  assert.equal(image.alt, 'A useful diagram')
  assert.equal(document.body.querySelectorAll('img').length, 1)
  const diagram = Buffer.from(image.src.split(',')[1], 'base64').toString('utf8')
  assert.match(diagram, /<linearGradient/u)
  assert.match(diagram, /viewBox="0 0 100 50"/u)
  assert.match(diagram, /Keep label/u)
  assert.doesNotMatch(diagram, /script|onload|foreignObject|<image|tracker.com|bad\(\)|unsafe/u)
  assert.match(content.text, /Untrusted source data/u)
  assert.equal(domText(content.html), content.text)
})

test('oversized inline diagrams offer an original-page entry instead of disappearing', () => {
  const content = normalizeReadingContent(`<p>Text.</p><svg><desc>${'x'.repeat(2 * 1024 * 1024)}</desc></svg>`, { baseUrl })
  assert.match(content.html, /data-reading-media-fallback="image"/u)
  assert.match(content.text, /View diagram on the original page/u)
  assert.doesNotMatch(content.html, /data:image/u)
})
