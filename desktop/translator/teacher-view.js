const $ = (id) => document.getElementById(id)

const VERDICT_LABELS = {
  understood: '理解到位',
  partial: '抓住了一部分',
  missed: '再看一下这段',
}

function setStatus(el, text, kind = '') {
  el.textContent = text
  el.dataset.kind = kind
}

function focusIfVisible(el) {
  if (el.closest('[hidden]') || document.querySelector('dialog[open]')) return false
  el.focus()
  return true
}

function createHints(listEl, buttonEl, firstLabel) {
  let hints = []

  function updateButton() {
    buttonEl.hidden = listEl.childElementCount >= hints.length
    buttonEl.textContent = listEl.childElementCount ? '再提示一点' : firstLabel
  }

  function reveal() {
    const hint = hints[listEl.childElementCount]
    if (!hint) return
    const itemEl = document.createElement('li')
    itemEl.textContent = hint
    listEl.append(itemEl)
    listEl.hidden = false
    const hadFocus = document.activeElement === buttonEl
    updateButton()
    if (hadFocus && buttonEl.hidden) {
      itemEl.tabIndex = -1
      itemEl.focus()
    }
  }

  buttonEl.addEventListener('click', reveal)

  return {
    get revealedCount() { return listEl.childElementCount },
    load(entries, isFirstVisible = false) {
      hints = entries
      listEl.replaceChildren()
      listEl.hidden = true
      updateButton()
      if (isFirstVisible) reveal()
    },
  }
}

function createPracticeView({ api, run, isBusy }) {
  const introEl = $('practice-intro')
  const lessonEl = $('practice-lesson')
  const feedbackEl = $('practice-feedback')
  const startEl = $('practice-start')
  const submitEl = $('practice-submit')
  const nextEl = $('practice-next')
  const answerEl = $('practice-answer')
  const answerFormEl = $('practice-form')
  const submittedAnswerEl = $('practice-submitted-answer')
  const passageEl = $('practice-passage')
  const hints = createHints($('practice-hints'), $('practice-hint'), '给个提示')
  let overviewRevision = 0

  function updateControls() {
    const hasFeedback = !feedbackEl.hidden
    startEl.disabled = nextEl.disabled = isBusy()
    answerEl.readOnly = isBusy()
    answerFormEl.hidden = hasFeedback
    submittedAnswerEl.hidden = !hasFeedback
    submitEl.disabled = isBusy() || !answerEl.value.trim()
  }

  async function refresh() {
    const revision = ++overviewRevision
    try {
      const { lookups, practiceCount, focus } = await api.teacherOverview()
      if (revision !== overviewRevision) return
      const intro = lookups.length ? '这次可以从这些查过的词开始。' : '先试读一段短文，老师会根据作答调整练习。'
      $('practice-overview').textContent = practiceCount
        ? [`已完成 ${practiceCount} 次练习`, focus && `最近在练 ${focus}`].filter(Boolean).join(' · ')
        : intro
      const chips = lookups.map(({ text, count }) => {
        const chipEl = document.createElement('span')
        chipEl.className = 'term-chip'
        chipEl.textContent = count > 1 ? `${text} ×${count}` : text
        return chipEl
      })
      $('practice-terms').replaceChildren(...chips)
      $('practice-terms').hidden = !chips.length
      const privacyEl = $('practice-privacy')
      privacyEl.hidden = !chips.length && !focus
      const sharedData = [chips.length && '这些词条', focus && '上次学习重点'].filter(Boolean).join('和')
      privacyEl.textContent = sharedData ? `开始练习会把${sharedData}发给模型。` : ''
    } catch { }
  }

  function start() {
    return run('practice', '正在准备阅读材料…', () => api.teacherStart(), ({ lesson }) => {
      passageEl.textContent = lesson.passage
      $('practice-question').textContent = lesson.question
      hints.load(lesson.hints)
      answerEl.value = ''
      introEl.hidden = true
      feedbackEl.hidden = true
      lessonEl.hidden = false
      focusIfVisible(passageEl)
    })
  }

  function grade(event) {
    event.preventDefault()
    const answer = answerEl.value.trim()
    if (!answer || !feedbackEl.hidden) return
    const response = { answer, hintsUsed: hints.revealedCount }
    return run('practice', '老师正在看你的回答…', () => api.teacherGrade(response), ({ feedback }) => {
      const verdictEl = $('practice-verdict')
      verdictEl.textContent = VERDICT_LABELS[feedback.verdict]
      $('practice-feedback-text').textContent = feedback.feedback
      $('practice-focus').textContent = feedback.focus ? `接下来练 ${feedback.focus}` : ''
      $('practice-focus').hidden = !feedback.focus
      submittedAnswerEl.textContent = `你的回答：${answer}`
      feedbackEl.hidden = false
      updateControls()
      if (focusIfVisible(verdictEl)) feedbackEl.scrollIntoView({ block: 'nearest' })
    })
  }

  startEl.addEventListener('click', start)
  nextEl.addEventListener('click', start)
  answerFormEl.addEventListener('submit', grade)
  answerEl.addEventListener('input', updateControls)

  return {
    updateControls,
    refresh,
    reset() {
      introEl.hidden = false
      lessonEl.hidden = feedbackEl.hidden = true
      answerEl.value = ''
      passageEl.textContent = ''
      $('practice-question').textContent = ''
      $('practice-verdict').textContent = ''
      $('practice-feedback-text').textContent = ''
      $('practice-focus').textContent = ''
      submittedAnswerEl.textContent = ''
      hints.load([])
      updateControls()
    },
  }
}

function createGuideView({ api, run, isBusy }) {
  const textEl = $('guide-text')
  const startEl = $('guide-start')
  const resultEl = $('guide-result')
  const phoneticEl = $('guide-phonetic')
  const revealEl = $('guide-reveal')
  const answerEl = $('guide-answer')
  const hints = createHints($('guide-hints'), $('guide-more'), '看提示')
  revealEl.setAttribute('aria-controls', answerEl.id)

  function setResult(guide) {
    resultEl.hidden = !guide
    phoneticEl.textContent = guide?.phonetic || ''
    phoneticEl.hidden = !guide?.phonetic
    hints.load(guide?.hints || [], Boolean(guide))
    for (const field of ['meaning', 'explanation', 'example', 'usage']) {
      const el = $(`guide-${field}`)
      el.textContent = guide?.answer?.[field] || ''
      el.hidden = !el.textContent
    }
    answerEl.hidden = true
    revealEl.setAttribute('aria-expanded', 'false')
    revealEl.textContent = '看解析'
  }

  function updateControls() {
    textEl.readOnly = isBusy()
    startEl.disabled = isBusy() || !textEl.value.trim()
  }

  $('guide-form').addEventListener('submit', (event) => {
    event.preventDefault()
    const text = textEl.value.trim()
    if (!text) return
    void run('guide', '正在生成阅读提示…', () => api.teacherGuide(text), ({ guide }) => {
      setResult(guide)
      focusIfVisible($('guide-result-heading'))
    })
  })
  textEl.addEventListener('input', () => {
    if (!resultEl.hidden) setResult(null)
    updateControls()
  })
  revealEl.addEventListener('click', () => {
    answerEl.hidden = !answerEl.hidden
    revealEl.setAttribute('aria-expanded', String(!answerEl.hidden))
    revealEl.textContent = answerEl.hidden ? '看解析' : '收起解析'
    if (!answerEl.hidden) answerEl.scrollIntoView({ block: 'nearest' })
  })

  return { updateControls }
}

export function createTeacherView({ api, openSettings }) {
  const clearEl = $('teacher-clear')
  const dialogEl = $('teacher-clear-dialog')
  const confirmEl = $('teacher-clear-confirm')
  let isPending = false
  const isBusy = () => isPending
  const practice = createPracticeView({ api, run, isBusy })
  const guide = createGuideView({ api, run, isBusy })

  function setBusy(value) {
    isPending = value
    clearEl.disabled = value
    practice.updateControls()
    guide.updateControls()
  }

  function setAlert(scope, message = '', kind = '', hasSettingsAction = false) {
    setStatus($(`${scope}-status`), message, kind)
    $(`${scope}-configure`).hidden = !hasSettingsAction
  }

  async function run(scope, message, task, apply) {
    if (isPending) return
    setBusy(true)
    setAlert(scope, message, 'working')
    try {
      const result = await task()
      if (result?.code === 'configuration') {
        setAlert(scope, '请先配置 API 服务和通用学习模型。', 'error', true)
        return
      }
      if (result?.code === 'invalid-input') {
        const hint = scope === 'guide' ? '请将原文控制在 12,000 字符以内。' : '请检查回答内容，最多 1,200 字符。'
        setAlert(scope, hint, 'error')
        return
      }
      if (!result?.ok) throw new Error('Learning request failed')
      apply(result)
      setAlert(scope)
    } catch {
      setAlert(scope, '这次没收到可用的结果，请重试。', 'error')
    } finally {
      setBusy(false)
    }
  }

  function switchTab(selected) {
    for (const tab of ['practice', 'guide']) {
      $(`${tab}-tab`).setAttribute('aria-pressed', String(tab === selected))
      $(`teacher-${tab}`).hidden = tab !== selected
    }
  }

  for (const tab of ['practice', 'guide']) {
    $(`${tab}-tab`).addEventListener('click', () => switchTab(tab))
    $(`${tab}-configure`).addEventListener('click', openSettings)
  }
  clearEl.addEventListener('click', () => {
    $('teacher-clear-status').hidden = true
    dialogEl.showModal()
  })
  $('teacher-clear-cancel').addEventListener('click', () => dialogEl.close())
  dialogEl.addEventListener('cancel', (event) => {
    if (isPending) event.preventDefault()
  })
  confirmEl.addEventListener('click', async () => {
    if (isPending) return
    const cancelEl = $('teacher-clear-cancel')
    const statusEl = $('teacher-clear-status')
    setBusy(true)
    confirmEl.disabled = cancelEl.disabled = true
    statusEl.hidden = true
    try {
      const result = await api.teacherClear()
      if (!result?.ok) throw new Error('Unable to clear teacher data')
      practice.reset()
      setAlert('practice')
      void practice.refresh()
      dialogEl.close()
    } catch {
      setStatus(statusEl, '清除失败，请重试。', 'error')
      statusEl.hidden = false
    } finally {
      confirmEl.disabled = cancelEl.disabled = false
      setBusy(false)
      if (!dialogEl.open) focusIfVisible(clearEl)
    }
  })

  setBusy(false)
  return { show: practice.refresh }
}
