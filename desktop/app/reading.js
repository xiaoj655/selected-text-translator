import { button, coachErrorText, createReviewWorkspace, el, englishText } from './tutor.js'
import { createReadingLookup } from './reading-lookup.js'
import { createReadingMaterial, readingFocusText } from './reading-material.js'

export function createTutorWorkspace({ rootEl, api, readingApi, onOpenSettings }) {
  const shell = el('div', 'tutor-shell')
  const lookupDock = el('div', 'reading-lookup-dock')
  lookupDock.hidden = true
  rootEl.before(shell)
  shell.append(rootEl, lookupDock)
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

  const reading = createReadingWorkspace({ rootEl: readingPanel, scroller: rootEl, lookupDock, api: readingApi, onOpenSettings,
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
    setArticleAppearance({ font, width, fit, lookupFont }) {
      const anchor = readingAnchor(rootEl)
      shell.style.setProperty('--article-font-size', `${font}px`)
      shell.style.setProperty('--article-width', fit ? '100%' : `${width}px`)
      shell.style.setProperty('--reading-lookup-font-size', `${lookupFont}px`)
      if (anchor) rootEl.scrollTop += anchor.range.getBoundingClientRect().top - anchor.top
    },
    close() { reading.close() },
    handleGuideShortcut: reading.handleGuideShortcut,
  }
}

function readingAnchor(scroller) {
  if (scroller.hidden || scroller.scrollTop <= 0) return null
  const top = scroller.getBoundingClientRect().top + 1
  for (const material of scroller.querySelectorAll('.reading-preview')) {
    const bounds = material.getBoundingClientRect()
    if (bounds.top > top || bounds.bottom <= top) continue
    const walker = document.createTreeWalker(material, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      range.selectNodeContents(text)
      if (range.getBoundingClientRect().bottom <= top) continue
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
  }
  return null
}

const CATEGORIES = {
  news: 'Recent news',
  engineering: 'Engineering blogs',
  ideas: 'Tech ideas',
}
const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium' })
const wordCountFormat = new Intl.NumberFormat('en')
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

function createReadingWorkspace({ rootEl, scroller, lookupDock, api, onOpenSettings, onLookup }) {
  const lookup = createReadingLookup({ rootEl, scroller, dock: lookupDock, onOpenSettings, onLookup })
  const index = el('div')
  const header = el('header', 'reading-header')
  const heading = el('h3', 'reading-heading', 'Choose an article')
  heading.tabIndex = -1
  const tools = el('div', 'reading-tools')
  const refresh = button('Refresh', 'reading-refresh', () => void loadArticles())
  const paste = button('Paste text', 'reading-paste', openPaste)
  const importLink = button('Open link', 'reading-import', openImport)
  const historyButton = button('History', 'reading-history', () => void openHistory())
  const clearHistory = button('Clear history', 'reading-history-clear', () => void removeAllHistory())
  clearHistory.hidden = true
  tools.append(importLink, paste, refresh, clearHistory)
  header.append(heading, tools)
  const filters = el('div', 'reading-filters')
  filters.setAttribute('role', 'group')
  filters.setAttribute('aria-label', 'Article categories')
  const categoryButtons = Object.entries(CATEGORIES).map(([id, label]) =>
    button(label, `reading-category-${id}`, () => selectCategory(id)))
  filters.append(...categoryButtons, historyButton)

  const listStatus = el('p', 'reading-meta reading-list-status')
  listStatus.setAttribute('role', 'status')
  const list = el('ul', 'reading-list')
  list.id = 'reading-articles'
  const historyList = el('ul', 'reading-list reading-history-list')
  historyList.id = 'reading-history-list'
  historyList.hidden = true
  index.append(header, filters, listStatus, list, historyList)
  const notice = el('div', 'reading-import-notice')
  notice.id = 'reading-import-notice'
  notice.hidden = true
  const noticeText = el('span')
  noticeText.setAttribute('role', 'status')
  const noticeOpen = button('Open article', 'reading-import-notice-open', () => void openSavedArticle(completedImport?.historyId, noticeOpen))
  const noticeDismiss = button('×', 'reading-import-notice-dismiss', () => { notice.hidden = true })
  noticeDismiss.setAttribute('aria-label', 'Dismiss import notification')
  notice.append(noticeText, noticeOpen, noticeDismiss)
  rootEl.append(notice, index)

  let category = 'news'
  let activePanel = null
  let showingHistory = false
  let completedImport = null
  let positionTimer = 0
  let restoringPosition = false
  const feeds = new Map()
  const sessions = new Map()
  const panelStates = new WeakMap()
  const readingPositions = new WeakMap()
  scroller.addEventListener('scroll', () => {
    if (!activePanel || activePanel.closest('[hidden]') || restoringPosition) return
    const focus = readingFocusText(activePanel, scroller)
    if (focus) readingPositions.set(activePanel, focus)
    rememberPosition()
    clearTimeout(positionTimer)
    positionTimer = setTimeout(savePosition, 450)
  })
  window.addEventListener('pagehide', savePosition)

  function rememberPosition() {
    const state = panelStates.get(activePanel)
    if (!state || !activePanel.isConnected || activePanel.closest('[hidden]')) return
    const material = activePanel.querySelector('.reading-preview')
    if (!material) return
    const anchor = readingAnchor(scroller)
    let offset = 0
    let top = material.getBoundingClientRect().top
    if (anchor && material.contains(anchor.range.startContainer)) {
      const before = anchor.range.cloneRange()
      before.selectNodeContents(material)
      before.setEnd(anchor.range.startContainer, anchor.range.startOffset)
      offset = before.toString().length
      top = anchor.top
    }
    state.position = { offset, top: top - scroller.getBoundingClientRect().top,
      progress: material.textContent.length ? offset / material.textContent.length : 0 }
  }

  function savePosition() {
    clearTimeout(positionTimer)
    const state = panelStates.get(activePanel)
    if (!state?.article.historyId || !state.position) return
    void api.savePosition({ id: state.article.historyId, position: state.position }).catch(() => {})
  }

  function restorePosition(panel) {
    if (!panel.isConnected || panel.closest('[hidden]')) return
    const position = panelStates.get(panel)?.position
    restoringPosition = true
    scroller.scrollTop = 0
    const apply = () => {
      if (activePanel !== panel || !panel.isConnected || panel.closest('[hidden]')) return
      const material = panel.querySelector('.reading-preview')
      if (!material || !position) return
      const walker = document.createTreeWalker(material, NodeFilter.SHOW_TEXT)
      let offset = position.offset
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (offset > node.length) { offset -= node.length; continue }
        const range = document.createRange()
        range.setStart(node, offset)
        range.collapse(true)
        scroller.scrollTop += range.getBoundingClientRect().top - scroller.getBoundingClientRect().top - position.top
        break
      }
    }
    apply()
    requestAnimationFrame(() => {
      apply()
      requestAnimationFrame(() => { restoringPosition = false })
    })
  }

  async function openSavedArticle(id, origin) {
    if (!id) return
    origin.disabled = true
    try {
      const article = await api.restore(id)
      notice.hidden = true
      openArticle(article, origin)
    } catch (error) {
      listStatus.textContent = coachErrorText(error, 'Couldn’t open this saved article. Try again.')
    } finally { origin.disabled = false }
  }

  async function openHistory() {
    showPanel(null)
    showingHistory = true
    heading.textContent = 'Reading history'
    historyButton.setAttribute('aria-pressed', 'true')
    refresh.hidden = true
    clearHistory.hidden = false
    filters.hidden = false
    for (const categoryButton of categoryButtons) categoryButton.setAttribute('aria-pressed', 'false')
    list.hidden = true
    historyList.hidden = false
    listStatus.textContent = 'Loading history…'
    await renderHistory()
    scroller.scrollTop = 0
  }

  async function renderHistory() {
    try {
      const history = await api.history()
      if (!showingHistory) return
      clearHistory.disabled = !history.length
      listStatus.textContent = history.length ? 'Saved on this device. Open an article to continue reading.' : 'No imported articles yet. Open a link or paste text to start reading.'
      historyList.replaceChildren(...history.map((article) => {
        const item = el('li', 'reading-history-item')
        const content = el('div', 'reading-history-content')
        const open = button(article.title, '', () => void openSavedArticle(article.id, open), 'reading-article-title reading-history-open')
        open.dataset.historyId = article.id
        open.lang = 'en'
        const details = el('p', 'reading-meta')
        details.append(article.source || 'Pasted text', ' · ', dateFormat.format(new Date(article.lastOpenedAt)))
        if (article.progress > 0.01) details.append(` · ${Math.round(article.progress * 100)}% read`)
        const excerpt = englishText('p', 'reading-history-excerpt', article.excerpt.replace(/\s+/gu, ' '))
        content.append(open, details, excerpt)
        const remove = button('Remove', '', async () => {
          remove.disabled = true
          try {
            await api.removeHistory(article.id)
            forgetSessions(article.id)
            if (completedImport?.historyId === article.id) notice.hidden = true
            await renderHistory()
          } catch { listStatus.textContent = 'Couldn’t remove the article. Try again.'; remove.disabled = false }
        }, 'reading-history-remove')
        remove.setAttribute('aria-label', `Remove ${article.title} from history`)
        item.append(content, remove)
        return item
      }))
    } catch { listStatus.textContent = 'Couldn’t load reading history. Try again.' }
  }

  function forgetSessions(historyId) {
    for (const [id, panel] of sessions) {
      if (!historyId || panelStates.get(panel)?.article.historyId === historyId) sessions.delete(id)
    }
  }

  async function removeAllHistory() {
    clearHistory.disabled = true
    try {
      await api.clearHistory()
      forgetSessions()
      notice.hidden = true
      await renderHistory()
    } catch { listStatus.textContent = 'Couldn’t clear reading history. Try again.'; clearHistory.disabled = false }
  }

  function importCompleted(article, form, origin) {
    completedImport = article
    if (activePanel === form && !form.closest('[hidden]')) {
      notice.hidden = true
      openArticle(article, origin)
    } else {
      noticeText.textContent = `Ready to read: ${article.title}`
      noticeOpen.hidden = false
      notice.hidden = false
      if (showingHistory && !activePanel) void renderHistory()
    }
  }

  function renderIndex() {
    if (showingHistory) return
    const feed = feeds.get(category)
    for (const [idx, id] of Object.keys(CATEGORIES).entries()) {
      categoryButtons[idx].setAttribute('aria-pressed', String(id === category))
    }
    refresh.disabled = Boolean(feed?.pending)
    list.setAttribute('aria-busy', String(Boolean(feed?.pending)))
    if (feed?.pending) {
      listStatus.textContent = 'Loading articles…'
    } else if (feed?.refreshFailed && feed.articles.length) {
      listStatus.textContent = 'Couldn’t refresh. You can still open the articles already loaded.'
    } else if (feed?.articles?.length) {
      const unavailable = feed.unavailableSources.length
        ? `Couldn’t load ${feed.unavailableSources.join(', ')}.`
        : ''
      const stale = feed.staleSources?.length
        ? ` Showing previous results from ${feed.staleSources.join(', ')}.`
        : ''
      listStatus.textContent = unavailable + stale
    } else {
      listStatus.textContent = 'No articles are available right now. Refresh or paste your own text.'
    }
    list.replaceChildren(...(feed?.articles || []).map((article) => {
      const item = el('li')
      const open = button(article.title, '', () => openArticle(article, open), 'reading-article-title')
      open.lang = 'en'
      const meta = attribution(article)
      if (article.feedHasBody) {
        const words = article.text.match(/\S+/gu)?.length ?? 0
        meta.append(' · About ', wordCountFormat.format(words), ' words in feed')
      } else {
        meta.append(' · Summary only · Import for full article')
      }
      item.append(open)
      if (article.excerpt) item.append(englishText('p', 'reading-meta reading-article-excerpt', article.excerpt))
      item.append(meta)
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
      feeds.set(selected, await api.discover(selected))
    } catch {
      feeds.set(selected, { ...previous, articles: previous?.articles || [], refreshFailed: true })
    }
    if (selected === category) renderIndex()
  }

  function selectCategory(id) {
    if (id === category && !showingHistory) return
    showingHistory = false
    heading.textContent = 'Choose an article'
    historyButton.setAttribute('aria-pressed', 'false')
    refresh.hidden = false
    clearHistory.hidden = true
    filters.hidden = false
    list.hidden = false
    historyList.hidden = true
    category = id
    if (feeds.has(id)) renderIndex()
    else void loadArticles()
  }

  function showPanel(panel) {
    rememberPosition()
    savePosition()
    lookup.close()
    for (const video of activePanel?.querySelectorAll('video') || []) video.pause()
    activePanel?.remove()
    activePanel = panel
    index.hidden = Boolean(panel)
    if (panel) rootEl.append(panel)
    else {
      filters.hidden = false
      if (showingHistory) void renderHistory()
    }
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
    input.rows = 8
    label.htmlFor = input.id
    const submit = el('button', 'primary', 'Open text')
    submit.type = 'submit'
    submit.id = 'reading-paste-open'
    form.append(backButton(paste), label, input, submit)
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      const pastedText = input.value.trim()
      if (!pastedText || submit.disabled) return
      submit.disabled = true
      try {
        const article = await api.paste(pastedText)
        importCompleted(article, form, paste)
      } catch (error) {
        pasteStatus.textContent = coachErrorText(error, 'Couldn’t save this text. Try again.')
      } finally { submit.disabled = false }
    })
    const pasteStatus = el('p', 'reading-meta')
    pasteStatus.setAttribute('role', 'status')
    form.append(pasteStatus)
    showPanel(form)
    input.focus()
  }

  function openImport() {
    const form = el('form', 'reading-paste-form')
    form.noValidate = true
    const label = el('label', '', 'Article link')
    const input = englishText('input', 'reading-input')
    input.id = 'reading-import-url'
    input.type = 'url'
    input.required = true
    input.maxLength = 4096
    input.placeholder = 'https://'
    label.htmlFor = input.id
    const submit = el('button', 'primary', 'Import article')
    submit.type = 'submit'
    const status = el('span', 'reading-meta')
    status.id = 'reading-import-status'
    status.setAttribute('role', 'status')
    const fallback = button('Paste text', '', openPaste)
    fallback.hidden = true
    const settings = button('Web import settings', 'reading-import-settings', () => {
      onOpenSettings('web-import-settings-heading')
      document.getElementById('cfg-iqs-key').focus({ preventScroll: true })
    })
    form.append(backButton(importLink), label, input, submit, status, fallback, settings)
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      if (submit.disabled) return
      if (!input.value.trim()) {
        status.textContent = 'Enter a public HTTPS article link.'
        input.focus()
        return
      }
      input.readOnly = true
      submit.disabled = true
      fallback.hidden = true
      status.textContent = 'Importing article…'
      try {
        const article = await api.importPage(input.value.trim())
        importCompleted(article, form, importLink)
      } catch (error) {
        status.textContent = coachErrorText(error, 'Couldn’t import this page. Try again or paste the text.')
        fallback.hidden = false
        if (activePanel !== form) {
          noticeText.textContent = status.textContent
          noticeOpen.hidden = true
          notice.hidden = false
        }
      } finally {
        input.readOnly = false
        submit.disabled = false
      }
    })
    showPanel(form)
    input.focus()
  }

  function openArticle(article, origin, pastedText) {
    const existing = sessions.get(article.id)
    if (existing) {
      showPanel(existing)
      existing.querySelector('h3').focus({ preventScroll: true })
      restorePosition(existing)
      return
    }
    const state = { turns: [], draft: '', pending: false }
    const panel = el('article', 'reading-detail')
    panel.id = 'reading-detail'
    panelStates.set(panel, { article, position: article.readingPosition })
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
    const materialOptions = { openLink: (url) => api.openLink(url),
      onError: () => { status.textContent = 'Couldn’t open the link. Try the original article.' } }
    if (article.kind === 'web_article' || article.kind === 'pasted_text' || article.html || pastedText) {
      const material = createReadingMaterial(article, materialOptions)
      lookup.bindMaterial(material, article)
      panel.append(material)
    } else if (excerpt) {
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
    if (article.url && article.kind !== 'web_article') {
      const importFull = button('Import full article', 'reading-import-full', async () => {
        if (importFull.disabled) return
        importFull.disabled = true
        importStatus.textContent = 'Importing article…'
        try {
          const full = await api.importPage(article.url)
          importCompleted(full, panel, origin)
        } catch (error) {
          importStatus.textContent = coachErrorText(error, 'Couldn’t import the full article. Open the original to continue.')
        } finally { importFull.disabled = false }
      })
      const importStatus = el('span', 'reading-meta')
      const importTools = el('div', 'reading-tools')
      importTools.append(importFull, importStatus)
      panel.append(importTools)
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
        const result = await api.discuss({ articleId: article.id, pastedText, question, history,
          focusText: question ? readingFocusText(panel, scroller) || readingPositions.get(panel) || '' : '' })
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
        status.textContent = result.contextPartial
          ? 'Coach is using selected passages from this long article. Scroll to a passage to ask about it.' : ''
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
    title.focus({ preventScroll: true })
    restorePosition(panel)
  }

  return {
    close() { rememberPosition(); savePosition(); lookup.close() },
    handleGuideShortcut: lookup.handleGuideShortcut,
    open() {
      const target = activePanel?.querySelector('h3, textarea, input') || heading
      target.focus({ preventScroll: true })
      if (panelStates.has(activePanel)) restorePosition(activePanel)
      if (!activePanel && !feeds.has(category)) void loadArticles()
    },
  }
}
