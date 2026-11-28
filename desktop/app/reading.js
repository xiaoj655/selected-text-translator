import { button, coachErrorText, createReviewWorkspace, el, englishText } from './tutor.js'
import { createReadingLookup } from './reading-lookup.js'
import { createReadingMaterial, readingFocusText } from './reading-material.js'
import { createVocabularyWorkspace } from './vocabulary.js'

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
  const vocabularyPanel = el('div')
  const reviewPanel = el('div')
  readingPanel.id = 'tutor-reading-panel'
  vocabularyPanel.id = 'tutor-vocabulary-panel'
  reviewPanel.id = 'tutor-review-panel'

  const reading = createReadingWorkspace({ rootEl: readingPanel, scroller: rootEl, lookupDock, api: readingApi, onOpenSettings,
    onLookup: (lookup) => api.recordLookup(lookup),
    async onVocabularyLookup({ id, text }) {
      await api.vocabularyLookup({ text, lookupId: id })
      vocabulary.refresh()
    } })
  const vocabulary = createVocabularyWorkspace({ rootEl: vocabularyPanel, api })
  const review = createReviewWorkspace({ rootEl: reviewPanel, api, onOpenSettings })
  const modes = [
    { workspace: reading, panel: readingPanel, label: 'Article reading', id: 'reading' },
    { workspace: vocabulary, panel: vocabularyPanel, label: 'Vocabulary', id: 'vocabulary' },
    { workspace: review, panel: reviewPanel, label: 'Review', id: 'review' },
  ]
  let activeMode = modes[0]
  for (const mode of modes) {
    mode.button = button(mode.label, `tutor-${mode.id}-mode`, () => setMode(mode))
    mode.button.setAttribute('aria-controls', mode.panel.id)
    nav.append(mode.button)
  }
  syncModes()
  frame.append(title, nav, ...modes.map((mode) => mode.panel))
  rootEl.append(frame)

  function syncModes() {
    for (const mode of modes) {
      mode.panel.hidden = mode !== activeMode
      mode.button.setAttribute('aria-pressed', String(mode === activeMode))
    }
  }

  function setMode(mode) {
    if (mode === activeMode) return
    activeMode.workspace.close?.()
    activeMode = mode
    syncModes()
    rootEl.scrollTop = 0
    activeMode.workspace.open()
  }

  return {
    open() { activeMode.workspace.open() },
    refresh() { activeMode.workspace.refresh?.() },
    setArticleAppearance({ font, width, fit, lookupFont }) {
      const anchor = readingAnchor(rootEl)
      shell.style.setProperty('--article-font-size', `${font}px`)
      shell.style.setProperty('--article-width', fit ? '100%' : `${width}px`)
      shell.style.setProperty('--reading-lookup-font-size', `${lookupFont}px`)
      if (anchor) rootEl.scrollTop += anchor.range.getBoundingClientRect().top - anchor.top
    },
    close() { activeMode.workspace.close?.() },
    handleResultShortcut(key, target) { return activeMode.workspace.handleResultShortcut?.(key, target) ?? false },
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
  news: 'Data & progress',
  engineering: 'Engineering blogs',
  ideas: 'Essays & ideas',
  chinese: 'Chinese blogs',
  custom: 'My feeds',
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

function createReadingWorkspace({ rootEl, scroller, lookupDock, api, onOpenSettings, onLookup, onVocabularyLookup }) {
  const lookup = createReadingLookup({ rootEl, scroller, dock: lookupDock, onOpenSettings, onLookup, onVocabularyLookup })
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

  const feedActions = el('div', 'reading-tools reading-feed-actions')
  feedActions.hidden = true
  const addFeed = button('Add feed', 'reading-feed-add', openAddFeed, 'primary')
  const manageFeeds = button('Manage feeds', 'reading-feed-manage', openFeedManagement)
  feedActions.append(addFeed, manageFeeds)

  const listStatus = el('p', 'reading-meta reading-list-status')
  listStatus.setAttribute('role', 'status')
  const list = el('ul', 'reading-list')
  list.id = 'reading-articles'
  const historyList = el('ul', 'reading-list reading-history-list')
  historyList.id = 'reading-history-list'
  historyList.hidden = true
  index.append(header, filters, feedActions, listStatus, list, historyList)
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

  const feedManagement = el('section')
  const managementTitle = el('h3', 'reading-heading', 'Manage feeds')
  managementTitle.tabIndex = -1
  const managementStatus = el('p', 'reading-meta reading-list-status')
  managementStatus.id = 'reading-feed-management-status'
  managementStatus.setAttribute('role', 'status')
  const managedSources = el('ul', 'reading-list reading-feed-sources')
  managedSources.id = 'reading-feed-sources'
  feedManagement.append(backButton(manageFeeds), managementTitle, managementStatus, managedSources)

  let category = 'news'
  let activePanel = null
  let showingHistory = false
  let completedImport = null
  let positionTimer = 0
  let restoringPosition = false
  let changingFeeds = false
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
    return api.savePosition({ id: state.article.historyId, articleId: state.article.id, position: state.position }).catch(() => {})
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
      const range = document.createRange()
      let offset = position.offset
      let boundary
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (offset > node.length) { offset -= node.length; continue }
        range.setStart(node, offset)
        range.collapse(true)
        const bounds = range.getBoundingClientRect()
        if (bounds.height) {
          boundary = bounds
          if (offset < node.length) break
        }
        // A text offset at a node boundary can fall on collapsed whitespace.
        offset = 0
      }
      if (boundary) scroller.scrollTop += boundary.top - scroller.getBoundingClientRect().top - position.top
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

  async function openFeedArticle(article, origin) {
    origin.disabled = true
    let saved
    let saveError = ''
    try {
      saved = await api.openFeed(article.id)
    } catch {
      saveError = 'Couldn’t save this article to reading history.'
    } finally { origin.disabled = false }
    if (!origin.isConnected || origin.closest('[hidden]')) return
    openArticle(saved || article, origin, saveError)
  }

  async function openHistory() {
    showPanel(null)
    showingHistory = true
    heading.textContent = 'Reading history'
    historyButton.setAttribute('aria-pressed', 'true')
    refresh.hidden = true
    feedActions.hidden = true
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
      listStatus.textContent = history.length ? 'Saved on this device. Open an article to continue reading.' : 'No articles in your reading history yet.'
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
    const custom = category === 'custom'
    const feed = feeds.get(category)
    for (const [idx, id] of Object.keys(CATEGORIES).entries()) {
      categoryButtons[idx].setAttribute('aria-pressed', String(id === category))
    }
    refresh.disabled = Boolean(feed?.pending || (custom && changingFeeds))
    feedActions.hidden = !custom
    addFeed.disabled = changingFeeds
    manageFeeds.disabled = changingFeeds
    list.setAttribute('aria-busy', String(Boolean(feed?.pending)))
    if (feed?.pending) {
      listStatus.textContent = 'Loading articles…'
    } else if (feed?.refreshFailed && feed.articles.length) {
      listStatus.textContent = 'Couldn’t refresh. You can still open the articles already loaded.'
    } else if (custom && feed?.refreshFailed) {
      listStatus.textContent = 'Couldn’t load your feeds. Try refreshing.'
    } else if (feed?.articles?.length || (custom && feed?.unavailableSources?.length)) {
      const unavailable = feed.unavailableSources.length
        ? `Couldn’t load ${feed.unavailableSources.join(', ')}.`
        : ''
      const stale = feed.staleSources?.length
        ? ` Showing previous results from ${feed.staleSources.join(', ')}.`
        : ''
      listStatus.textContent = unavailable + stale
    } else if (custom) {
      listStatus.textContent = feed?.sources?.length
        ? 'No articles from your feeds yet.'
        : 'Add an RSS or Atom feed to see its latest articles.'
    } else {
      listStatus.textContent = 'No articles are available right now. Refresh or paste your own text.'
    }
    list.replaceChildren(...(feed?.articles || []).map((article) => {
      const item = el('li')
      const open = button(article.title, '', () => void openFeedArticle(article, open), 'reading-article-title')
      open.lang = 'en'
      const meta = attribution(article)
      if (article.feedHasBody) {
        if (category === 'chinese') {
          meta.append(' · Full text in feed')
        } else {
          const words = article.text.match(/\S+/gu)?.length ?? 0
          meta.append(' · About ', wordCountFormat.format(words), ' words in feed')
        }
      } else {
        const availability = article.excerpt ? 'Summary only' : 'Headline only'
        meta.append(' · ', availability, ' · Import for full article')
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
    if (previous?.pending || (selected === 'custom' && changingFeeds)) return
    const pending = { ...previous, pending: true }
    feeds.set(selected, pending)
    renderIndex()
    let result
    try {
      result = await api.discover(selected)
    } catch {
      result = { ...previous, articles: previous?.articles || [], refreshFailed: true }
    }
    if (feeds.get(selected) !== pending) return
    feeds.set(selected, result)
    if (selected === category) renderIndex()
    if (selected === 'custom' && activePanel === feedManagement && !changingFeeds) {
      renderManagedSources()
    }
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

  async function changeCustomFeeds(update) {
    changingFeeds = true
    if (category === 'custom') renderIndex()
    try {
      feeds.set('custom', await update())
    } finally {
      changingFeeds = false
      if (category === 'custom') renderIndex()
    }
  }

  function openAddFeed() {
    const form = el('form', 'reading-paste-form')
    form.noValidate = true
    const label = el('label', '', 'RSS or Atom feed URL')
    const input = el('input', 'reading-input')
    input.id = 'reading-feed-url'
    input.type = 'url'
    input.maxLength = 4096
    input.placeholder = 'https://'
    input.required = true
    label.htmlFor = input.id
    const submit = el('button', 'primary', 'Add feed')
    submit.id = 'reading-feed-submit'
    submit.type = 'submit'
    const status = el('span', 'reading-meta')
    status.id = 'reading-feed-status'
    status.setAttribute('role', 'status')
    const suggested = el('div', 'reading-tools')
    const currentSources = feeds.get('custom')?.sources ?? []
    const suggestions = (api.suggestedFeeds ?? [])
      .filter(({ url }) => !currentSources.some((source) => source.url === url))
      .map(({ id, name, url }) => button(`Subscribe to ${name}`, `reading-feed-preset-${id}`, () => void subscribe(url)))
    suggested.append(...suggestions)
    form.append(backButton(addFeed), label, input, submit)
    if (suggestions.length) form.append(suggested)
    form.append(status)
    async function subscribe(url) {
      if (changingFeeds) return
      if (!url) {
        status.textContent = 'Enter a public HTTP or HTTPS feed URL.'
        input.focus()
        return
      }
      input.readOnly = true
      submit.disabled = true
      for (const suggestion of suggestions) suggestion.disabled = true
      status.textContent = 'Checking feed…'
      try {
        await changeCustomFeeds(() => api.addFeed(url))
        if (activePanel === form) {
          showPanel(null)
          addFeed.focus({ preventScroll: true })
        }
      } catch (error) {
        status.textContent = coachErrorText(error, 'Couldn’t add the feed. Try again.')
        if (activePanel === form) input.focus({ preventScroll: true })
      } finally {
        input.readOnly = false
        submit.disabled = false
        for (const suggestion of suggestions) suggestion.disabled = false
      }
    }
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      void subscribe(input.value.trim())
    })
    showPanel(form)
    input.focus()
  }

  function openFeedManagement() {
    renderManagedSources()
    showPanel(feedManagement)
    managementTitle.focus()
  }

  function renderManagedSources(message = '') {
    const feed = feeds.get('custom')
    const sources = feed?.sources || []
    if (message) {
      managementStatus.textContent = message
    } else if (feed?.pending && !sources.length) {
      managementStatus.textContent = 'Loading feeds…'
    } else if (feed?.refreshFailed && !sources.length) {
      managementStatus.textContent = 'Couldn’t load your feeds. Try refreshing.'
    } else {
      managementStatus.textContent = sources.length ? '' : 'No feeds added yet.'
    }
    managedSources.replaceChildren(...sources.map(({ id, name, url }) => {
      const item = el('li')
      const content = el('div', 'reading-feed-source')
      content.append(el('p', 'reading-feed-name', name), el('p', 'reading-meta', url))
      const failure = feed.sourceErrors?.[id]
      if (failure) content.append(el('p', 'reading-meta', failure))
      const remove = button('Remove', '', () => void removeCustomFeed(id))
      remove.setAttribute('aria-label', `Remove ${name}`)
      item.append(content, remove)
      return item
    }))
  }

  async function removeCustomFeed(id) {
    if (changingFeeds) return
    for (const remove of managedSources.querySelectorAll('button')) remove.disabled = true
    managementStatus.textContent = 'Removing feed…'
    try {
      await changeCustomFeeds(() => api.removeFeed(id))
      renderManagedSources()
      if (activePanel === feedManagement) managementTitle.focus({ preventScroll: true })
    } catch (error) {
      renderManagedSources(coachErrorText(error, 'Couldn’t remove the feed. Try again.'))
    }
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

  function openArticle(article, origin, saveError = '') {
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
    let reload
    let reloadStatus
    let credit
    let material
    let importFull
    if (article.url) {
      original = el('a', 'reading-original', 'Open original ↗')
      original.id = 'reading-original'
      original.href = article.url
      original.addEventListener('auxclick', (event) => event.preventDefault())
      credit = attribution(article)
      const tools = el('div', 'reading-tools reading-meta reading-article-tools')
      tools.append(credit, original)
      if (article.historyId) {
        reload = button('Reload article', 'reading-reload', () => void reloadArticle(), 'reading-reload-action')
        reloadStatus = el('span')
        reloadStatus.id = 'reading-reload-status'
        reloadStatus.setAttribute('role', 'status')
        tools.append(reload, reloadStatus)
      }
      panel.append(tools)
    }
    if (saveError) panel.append(el('p', 'reading-meta', saveError))
    const excerpt = article.excerpt || article.text
    const materialOptions = { openLink: (url) => api.openLink(url),
      onError: () => { status.textContent = 'Couldn’t open the link. Try the original article.' } }
    if (article.kind === 'web_article' || article.kind === 'pasted_text' || article.kind === 'feed_article' || article.html) {
      material = createReadingMaterial(article, materialOptions)
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
        details.append(el('summary', '', 'Read more from the feed'), material)
        details.addEventListener('toggle', () => { if (!details.open) lookup.close() })
        panel.append(details)
      }
    } else {
      panel.append(el('p', 'reading-meta', 'This feed only provides a headline. Open the original or paste a passage to read here.'))
    }
    if (article.url && article.kind !== 'web_article') {
      importFull = button('Import full article', 'reading-import-full', async () => {
        if (importFull.disabled) return
        importFull.disabled = true
        if (reload) reload.disabled = true
        importStatus.textContent = 'Importing article…'
        try {
          const full = await api.importPage(article.url)
          importCompleted(full, panel, origin)
        } catch (error) {
          importStatus.textContent = coachErrorText(error, 'Couldn’t import the full article. Open the original to continue.')
        } finally {
          importFull.disabled = false
          if (reload) reload.disabled = false
        }
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

    async function reloadArticle() {
      if (reload.disabled) return
      rememberPosition()
      reload.disabled = true
      if (importFull) importFull.disabled = true
      reloadStatus.textContent = 'Reloading article…'
      try {
        await savePosition()
        const refreshed = await api.reloadArticle(article.historyId)
        if (sessions.get(article.id) !== panel) return
        const visible = activePanel === panel && !panel.closest('[hidden]')
        if (visible) {
          rememberPosition()
          lookup.close()
        }
        const saved = panelStates.get(panel)
        if (article.text !== refreshed.text) saved.position = refreshed.readingPosition
        forgetSessions(article.historyId)
        article = saved.article = refreshed
        sessions.set(article.id, panel)
        title.textContent = article.title
        original.href = article.url
        credit.replaceChildren(...attribution(article).childNodes)
        const refreshedMaterial = createReadingMaterial(article, { ...materialOptions, reloadImages: true })
        lookup.bindMaterial(refreshedMaterial, article)
        for (const video of material.querySelectorAll('video')) video.pause()
        material.replaceWith(refreshedMaterial)
        material = refreshedMaterial
        reloadStatus.textContent = 'Article reloaded.'
        if (visible) {
          restorePosition(panel)
          void savePosition()
        }
      } catch (error) {
        reloadStatus.textContent = coachErrorText(error, 'Couldn’t reload the article. Try again.')
      } finally {
        reload.disabled = false
        if (importFull) importFull.disabled = false
      }
    }

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
        const result = await api.discuss({ articleId: article.id, question, history,
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
    handleResultShortcut: lookup.handleResultShortcut,
    open() {
      const target = activePanel?.querySelector('h3, textarea, input') || heading
      target.focus({ preventScroll: true })
      if (panelStates.has(activePanel)) restorePosition(activePanel)
      if (!activePanel && !feeds.has(category)) void loadArticles()
    },
  }
}
