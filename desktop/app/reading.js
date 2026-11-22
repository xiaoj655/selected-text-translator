import { button, coachErrorText, createReviewWorkspace, el, englishText } from './tutor.js'
import { createReadingLookup } from './reading-lookup.js'

export function createTutorWorkspace({ rootEl, api, readingApi, onOpenSettings }) {
  const frame = el('div', 'tutor-frame')
  const title = el('h2', 'sr-only', 'English Coach')
  title.id = 'tutor-title'
  const nav = el('nav', 'tutor-modes')
  nav.setAttribute('aria-label', 'English Coach modes')
  const readingPanel = el('div')
  const reviewPanel = el('div')
  readingPanel.id = 'tutor-reading-panel'
  reviewPanel.id = 'tutor-review-panel'
  reviewPanel.hidden = true

  const reading = createReadingWorkspace({ rootEl: readingPanel, api: readingApi, onOpenSettings,
    onLookup: (lookup) => api.recordLookup(lookup) })
  const review = createReviewWorkspace({ rootEl: reviewPanel, api, onOpenSettings })
  const readingButton = button('Article reading', 'tutor-reading-mode', () => setMode(false))
  const reviewButton = button('Review', 'tutor-review-mode', () => setMode(true))
  readingButton.setAttribute('aria-controls', readingPanel.id)
  readingButton.setAttribute('aria-pressed', 'true')
  reviewButton.setAttribute('aria-controls', reviewPanel.id)
  reviewButton.setAttribute('aria-pressed', 'false')
  nav.append(readingButton, reviewButton)
  frame.append(title, nav, readingPanel, reviewPanel)
  rootEl.append(frame)

  function setMode(showReview) {
    if (reviewPanel.hidden === !showReview) return
    reading.close()
    readingPanel.hidden = showReview
    reviewPanel.hidden = !showReview
    readingButton.setAttribute('aria-pressed', String(!showReview))
    reviewButton.setAttribute('aria-pressed', String(showReview))
    rootEl.scrollTop = 0
    if (showReview) review.open()
    else reading.open()
  }

  return {
    open() {
      if (reviewPanel.hidden) reading.open()
      else review.open()
    },
    refresh() {
      if (!reviewPanel.hidden) review.refresh()
    },
    setArticleAppearance({ font, width, fit }) {
      const anchor = readingAnchor(rootEl)
      rootEl.style.setProperty('--article-font-size', `${font}px`)
      rootEl.style.setProperty('--article-width', fit ? '100%' : `${width}px`)
      if (anchor) rootEl.scrollTop += anchor.range.getBoundingClientRect().top - anchor.top
    },
    close() { reading.close() },
  }
}

function readingAnchor(scroller) {
  if (scroller.hidden || scroller.scrollTop <= 0) return null
  const top = scroller.getBoundingClientRect().top + 1
  for (const material of scroller.querySelectorAll('.reading-preview')) {
    const bounds = material.getBoundingClientRect()
    const text = material.firstChild
    if (bounds.top > top || bounds.bottom <= top || text?.nodeType !== Node.TEXT_NODE) continue
    // The prose is one text node. Find the first visible line without hit testing the Settings overlay.
    const range = document.createRange()
    let start = 0
    let end = text.length
    while (start < end) {
      const middle = Math.floor((start + end) / 2)
      range.setStart(text, middle)
      range.collapse(true)
      if (range.getBoundingClientRect().bottom <= top) start = middle + 1
      else end = middle
    }
    range.setStart(text, start)
    range.collapse(true)
    return { range, top: range.getBoundingClientRect().top }
  }
  return null
}

const CATEGORIES = {
  news: 'Recent news',
  engineering: 'Engineering blogs',
  ideas: 'Tech ideas',
}
const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium' })
const SETTINGS_REQUIRED = 'Add an API URL, API key, and learning model in Settings.'

function attribution({ source, publishedAt }) {
  const meta = el('p', 'reading-meta')
  meta.append(englishText('span', '', source))
  if (publishedAt) {
    const time = el('time', '', dateFormat.format(new Date(publishedAt)))
    time.dateTime = publishedAt
    meta.append(' · ', time)
  }
  return meta
}

function createReadingWorkspace({ rootEl, api, onOpenSettings, onLookup }) {
  const lookup = createReadingLookup({ rootEl, onOpenSettings, onLookup })
  const index = el('div')
  const header = el('header', 'reading-header')
  const heading = el('h3', 'reading-heading', 'Choose an article')
  heading.tabIndex = -1
  const tools = el('div', 'reading-tools')
  const refresh = button('Refresh', 'reading-refresh', () => void loadArticles())
  const paste = button('Paste text', 'reading-paste', openPaste)
  tools.append(paste, refresh)
  header.append(heading, tools)
  const filters = el('div', 'reading-filters')
  filters.setAttribute('role', 'group')
  filters.setAttribute('aria-label', 'Article categories')
  const categoryButtons = Object.entries(CATEGORIES).map(([id, label]) =>
    button(label, `reading-category-${id}`, () => selectCategory(id)))
  filters.append(...categoryButtons)

  const listStatus = el('p', 'reading-meta reading-list-status')
  listStatus.setAttribute('role', 'status')
  const list = el('ul', 'reading-list')
  list.id = 'reading-articles'
  index.append(header, filters, listStatus, list)
  rootEl.append(index)

  let category = 'news'
  let activePanel = null
  const feeds = new Map()
  const sessions = new Map()

  function renderIndex() {
    const feed = feeds.get(category)
    for (const [idx, id] of Object.keys(CATEGORIES).entries()) {
      categoryButtons[idx].setAttribute('aria-pressed', String(id === category))
    }
    refresh.disabled = Boolean(feed?.pending)
    list.setAttribute('aria-busy', String(Boolean(feed?.pending)))
    if (feed?.pending) {
      listStatus.textContent = 'Loading articles…'
    } else if (feed?.articles?.length) {
      listStatus.textContent = feed.unavailableSources.length
        ? `Couldn’t load ${feed.unavailableSources.join(', ')}.`
        : ''
    } else {
      listStatus.textContent = 'No articles are available right now. Refresh or paste your own text.'
    }
    list.replaceChildren(...(feed?.articles || []).map((article) => {
      const item = el('li')
      const open = button(article.title, '', () => openArticle(article, open), 'reading-article-title')
      open.lang = 'en'
      item.append(open, attribution(article))
      return item
    }))
  }

  async function loadArticles() {
    const selected = category
    const previous = feeds.get(selected)
    if (previous?.pending) return
    feeds.set(selected, { ...previous, pending: true })
    renderIndex()
    try {
      const result = await api.discover(selected)
      feeds.set(selected, { ...result, articles: result.articles.length ? result.articles : previous?.articles || [] })
    } catch {
      feeds.set(selected, previous || { articles: [], unavailableSources: [] })
      if (selected === category && previous?.articles?.length) {
        renderIndex()
        listStatus.textContent = 'Couldn’t refresh. You can still open the articles already loaded.'
        return
      }
    }
    if (selected === category) renderIndex()
  }

  function selectCategory(id) {
    if (id === category) return
    category = id
    if (feeds.has(id)) renderIndex()
    else void loadArticles()
  }

  function showPanel(panel) {
    lookup.close()
    activePanel?.remove()
    activePanel = panel
    index.hidden = Boolean(panel)
    if (panel) rootEl.append(panel)
  }

  function backButton(origin) {
    return button('‹ All articles', 'reading-back', () => {
      showPanel(null)
      if (origin.isConnected) origin.focus()
      else heading.focus()
    }, 'reading-back')
  }

  function openPaste() {
    const form = el('form', 'reading-paste-form')
    const label = el('label', '', 'Paste English text to read together')
    const input = englishText('textarea', 'reading-input')
    input.id = 'reading-paste-text'
    input.required = true
    input.maxLength = 12000
    input.rows = 8
    label.htmlFor = input.id
    const submit = el('button', 'primary', 'Open text')
    submit.type = 'submit'
    submit.id = 'reading-paste-open'
    form.append(backButton(paste), label, input, submit)
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const pastedText = input.value.trim()
      if (pastedText) openArticle({ title: 'Pasted text', text: pastedText }, paste, pastedText)
    })
    showPanel(form)
    input.focus()
  }

  function openArticle(article, origin, pastedText) {
    const existing = sessions.get(article.id)
    if (existing) {
      showPanel(existing)
      existing.querySelector('h3').focus()
      return
    }
    const state = { turns: [], draft: '', pending: false }
    const panel = el('article', 'reading-detail')
    panel.id = 'reading-detail'
    if (article.id) sessions.set(article.id, panel)
    const title = el('h3', 'reading-heading reading-title', article.title)
    if (article.id) title.lang = 'en'
    title.tabIndex = -1
    panel.append(backButton(origin), title)
    let original
    if (article.url) {
      original = el('a', 'reading-original', 'Open original ↗')
      original.id = 'reading-original'
      original.href = article.url
      original.addEventListener('auxclick', (event) => event.preventDefault())
      const meta = attribution(article)
      meta.append(' · ', original)
      panel.append(meta)
    }
    const excerpt = article.excerpt || article.text
    if (excerpt) {
      const limit = 620
      const preview = excerpt.length > limit ? `${excerpt.slice(0, limit).trimEnd()}…` : excerpt
      const previewEl = englishText('p', 'reading-preview', preview)
      lookup.bindMaterial(previewEl, article)
      panel.append(previewEl)
      const moreText = article.text?.length > excerpt.length ? article.text : excerpt
      if (moreText.length > preview.length) {
        const details = el('details', 'reading-material')
        const material = englishText('p', 'reading-preview', moreText)
        lookup.bindMaterial(material, article)
        details.append(el('summary', '', pastedText ? 'Read the full text' : 'Read more from the feed'),
          material)
        details.addEventListener('toggle', () => { if (!details.open) lookup.close() })
        panel.append(details)
      }
    } else {
      panel.append(el('p', 'reading-meta', 'This feed only provides a headline. Open the original or paste a passage to read here.'))
    }

    const thread = el('div', 'reading-thread')
    thread.id = 'reading-thread'
    thread.setAttribute('role', 'log')
    thread.setAttribute('aria-label', 'Article discussion')
    const status = el('p', 'reading-meta reading-discussion-status')
    status.setAttribute('role', 'status')
    const settings = button('Open model settings', '', onOpenSettings)
    settings.hidden = true
    const start = button('Read with Coach', 'reading-start', () => void discuss(''), 'primary')
    const suggestions = el('div', 'reading-suggestions')

    const form = el('form', 'reading-question-form')
    const label = el('label', '', 'Ask about this article')
    const input = el('textarea', 'reading-input')
    input.id = 'reading-question'
    input.rows = 2
    input.maxLength = 2500
    input.required = true
    input.value = state.draft
    input.placeholder = 'For example: Why does the author say this?'
    label.htmlFor = input.id
    const send = el('button', 'primary', 'Send')
    send.type = 'submit'
    send.id = 'reading-send'
    form.append(label, input, send)
    const pasteExcerpt = button('Paste a passage', '', openPaste)
    const discussion = el('div', 'reading-discussion')
    discussion.append(thread, status, settings)
    if (excerpt) discussion.append(start, suggestions, form)
    else discussion.append(pasteExcerpt)
    panel.append(discussion)

    function appendTurn({ role, text, quote }) {
      const entry = el('div', 'reading-turn')
      entry.dataset.role = role
      entry.append(el('p', 'reading-turn-speaker', role === 'user' ? 'You' : 'English Coach'),
        el('p', 'reading-turn-text', text))
      if (quote) entry.append(englishText('blockquote', 'reading-quote', quote))
      thread.append(entry)
    }

    function renderSuggestions(followups = []) {
      suggestions.replaceChildren(...followups.map((text) =>
        button(text, '', () => void discuss(text))))
    }

    function updateActions() {
      start.hidden = state.turns.length > 0
      start.disabled = state.pending
      send.disabled = state.pending || !state.draft.trim()
      for (const suggestion of suggestions.children) suggestion.disabled = state.pending
    }

    async function discuss(question) {
      if (state.pending) return
      state.pending = true
      updateActions()
      settings.hidden = true
      status.textContent = 'English Coach is reading…'
      try {
        const history = state.turns.slice(-8).map(({ role, text, quote }) =>
          ({ role, text: quote ? `${text}\n${quote}` : text }))
        const result = await api.discuss({ articleId: article.id, pastedText, question, history })
        if (question) {
          const userTurn = { role: 'user', text: question }
          state.turns.push(userTurn)
          appendTurn(userTurn)
          if (question === state.draft.trim()) input.value = state.draft = ''
        }
        const tutorTurn = { role: 'assistant', text: result.reply, quote: result.quote, followups: result.followups }
        state.turns.push(tutorTurn)
        appendTurn(tutorTurn)
        renderSuggestions(result.followups)
        status.textContent = ''
        if (panel.isConnected && !panel.closest('[hidden]')) {
          if (document.activeElement === document.body) input.focus({ preventScroll: true })
          thread.lastElementChild.scrollIntoView({ block: 'nearest' })
        }
      } catch (error) {
        status.textContent = coachErrorText(error, 'Couldn’t load a reply. Try again.')
        settings.hidden = status.textContent !== SETTINGS_REQUIRED
      } finally {
        state.pending = false
        updateActions()
      }
    }

    input.addEventListener('input', () => {
      state.draft = input.value
      updateActions()
    })
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const question = input.value.trim()
      if (question) void discuss(question)
    })
    original?.addEventListener('click', async (event) => {
      event.preventDefault()
      try {
        await api.openArticle(article.id)
      } catch {
        status.textContent = 'Couldn’t open the article. Copy the link to open it in your browser.'
      }
    })

    updateActions()
    showPanel(panel)
    title.focus()
  }

  return {
    close() { lookup.close() },
    open() {
      const target = activePanel?.querySelector('h3, textarea') || heading
      target.focus()
      if (!activePanel && !feeds.has(category)) void loadArticles()
    },
  }
}
