import { button, createReviewWorkspace, el, englishText } from './tutor.js'

export function createTutorWorkspace({ rootEl, api, readingApi, onOpenSettings }) {
  const frame = el('div', 'tutor-frame')
  const title = el('h2', 'sr-only', 'AI 老师')
  title.id = 'tutor-title'
  const nav = el('nav', 'tutor-modes')
  nav.setAttribute('aria-label', 'AI 老师模式')
  const readingPanel = el('div')
  const reviewPanel = el('div')
  readingPanel.id = 'tutor-reading-panel'
  reviewPanel.id = 'tutor-review-panel'
  reviewPanel.hidden = true

  const reading = createReadingWorkspace({ rootEl: readingPanel, api: readingApi, onOpenSettings })
  const review = createReviewWorkspace({ rootEl: reviewPanel, api, onOpenSettings })
  const readingButton = button('文章带读', 'tutor-reading-mode', () => setMode(false))
  const reviewButton = button('复习练习', 'tutor-review-mode', () => setMode(true))
  readingButton.setAttribute('aria-controls', readingPanel.id)
  readingButton.setAttribute('aria-pressed', 'true')
  reviewButton.setAttribute('aria-controls', reviewPanel.id)
  reviewButton.setAttribute('aria-pressed', 'false')
  nav.append(readingButton, reviewButton)
  frame.append(title, nav, readingPanel, reviewPanel)
  rootEl.append(frame)

  function setMode(showReview) {
    if (reviewPanel.hidden === !showReview) return
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
  }
}

const CATEGORIES = {
  news: '近期新闻',
  engineering: '工程博客',
  ideas: '技术思考',
}
const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' })
const SETTINGS_REQUIRED = '请先在设置中配置 API 地址、密钥和通用学习模型。'

function readingError(error, fallback) {
  const message = String(error?.message || '').replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '')
  return /^[\p{Script=Han}]/u.test(message) ? message : fallback
}

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

function createReadingWorkspace({ rootEl, api, onOpenSettings }) {
  const index = el('div')
  const header = el('header', 'reading-header')
  const heading = el('h3', 'reading-heading', '选一篇文章')
  heading.tabIndex = -1
  const tools = el('div', 'reading-tools')
  const refresh = button('刷新', 'reading-refresh', () => void loadArticles())
  const paste = button('粘贴英文', 'reading-paste', openPaste)
  tools.append(paste, refresh)
  header.append(heading, tools)
  const filters = el('div', 'reading-filters')
  filters.setAttribute('role', 'group')
  filters.setAttribute('aria-label', '文章来源分类')
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
      listStatus.textContent = '正在获取文章…'
    } else if (feed?.articles?.length) {
      listStatus.textContent = feed.unavailableSources.length
        ? `暂时无法读取 ${feed.unavailableSources.join('、')}。`
        : ''
    } else {
      listStatus.textContent = '暂时读不到文章。可以刷新重试，或粘贴英文自己选材。'
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
        listStatus.textContent = '刷新失败，仍可打开此前载入的文章。'
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
    activePanel?.remove()
    activePanel = panel
    index.hidden = Boolean(panel)
    if (panel) rootEl.append(panel)
  }

  function backButton(origin) {
    return button('‹ 返回文章列表', 'reading-back', () => {
      showPanel(null)
      if (origin.isConnected) origin.focus()
      else heading.focus()
    }, 'reading-back')
  }

  function openPaste() {
    const form = el('form', 'reading-paste-form')
    const label = el('label', '', '粘贴想一起读的英文')
    const input = englishText('textarea', 'reading-input')
    input.id = 'reading-paste-text'
    input.required = true
    input.maxLength = 12000
    input.rows = 8
    label.htmlFor = input.id
    const submit = el('button', 'primary', '开始阅读')
    submit.type = 'submit'
    submit.id = 'reading-paste-open'
    form.append(backButton(paste), label, input, submit)
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const pastedText = input.value.trim()
      if (pastedText) openArticle({ title: '自选英文', text: pastedText }, paste, pastedText)
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
      original = el('a', 'reading-original', '打开原文 ↗')
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
      panel.append(englishText('p', 'reading-preview', preview))
      const moreText = article.text?.length > excerpt.length ? article.text : excerpt
      if (moreText.length > preview.length) {
        const details = el('details', 'reading-material')
        details.append(el('summary', '', pastedText ? '查看粘贴的全文' : '展开订阅中的英文'),
          englishText('p', 'reading-preview', moreText))
        panel.append(details)
      }
    } else {
      panel.append(el('p', 'reading-meta', '这条订阅只提供标题。可以打开原文，或粘贴想读的段落。'))
    }

    const thread = el('div', 'reading-thread')
    thread.id = 'reading-thread'
    thread.setAttribute('role', 'log')
    thread.setAttribute('aria-label', '带读对话')
    const status = el('p', 'reading-meta reading-discussion-status')
    status.setAttribute('role', 'status')
    const settings = button('打开模型设置', '', onOpenSettings)
    settings.hidden = true
    const start = button('让老师带我读', 'reading-start', () => void discuss(''), 'primary')
    const suggestions = el('div', 'reading-suggestions')

    const form = el('form', 'reading-question-form')
    const label = el('label', '', '和老师聊聊这篇文章')
    const input = el('textarea', 'reading-input')
    input.id = 'reading-question'
    input.rows = 2
    input.maxLength = 2500
    input.required = true
    input.value = state.draft
    input.placeholder = '例如：作者为什么这么说？'
    label.htmlFor = input.id
    const send = el('button', 'primary', '发送')
    send.type = 'submit'
    send.id = 'reading-send'
    form.append(label, input, send)
    const pasteExcerpt = button('粘贴想读的段落', '', openPaste)
    panel.append(thread, status, settings)
    if (excerpt) panel.append(start, suggestions, form)
    else panel.append(pasteExcerpt)

    function appendTurn({ role, text, quote }) {
      const entry = el('div', 'reading-turn')
      entry.dataset.role = role
      entry.append(el('p', 'reading-turn-speaker', role === 'user' ? '你' : 'AI 老师'),
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
      status.textContent = '老师正在阅读…'
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
        status.textContent = readingError(error, '暂时无法带读，请重试。')
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
        status.textContent = '无法打开原文，可以复制链接在浏览器中打开。'
      }
    })

    updateActions()
    showPanel(panel)
    title.focus()
  }

  return {
    open() {
      const target = activePanel?.querySelector('h3, textarea') || heading
      target.focus()
      if (!activePanel && !feeds.has(category)) void loadArticles()
    },
  }
}
