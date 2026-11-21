const KIND_LABELS = { phrase: '读懂句中的短语', sentence: '读懂整句' }
const OUTCOME_LABELS = {
  independent: '每道新句都独立读对了。',
  hinted: '经过提示或订正，最后一道新句读对了。',
  incorrect: '最后一道新句还有卡点，下一次会换个场景再练。',
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

function button(label, id, onClick, className) {
  const node = el('button', className, label)
  node.type = 'button'
  if (id) node.id = id
  node.addEventListener('click', onClick)
  return node
}

function englishText(tag, className, text) {
  const node = el(tag, className, text)
  node.lang = 'en'
  return node
}

function lessonError(error) {
  const message = String(error?.message || '').replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '')
  return /^[\p{Script=Han}]/u.test(message) ? message : '生成练习失败，请重试。'
}

function lessonOutcome(answers) {
  if (!answers.at(-1).correct) return 'incorrect'
  return answers.every((answer) => answer.correct && !answer.hinted) ? 'independent' : 'hinted'
}

export function createTutorWorkspace({ rootEl, api, onOpenSettings }) {
  const frameEl = el('div', 'tutor-frame')
  const titleEl = el('h2', 'tutor-title', 'AI 老师')
  titleEl.id = 'tutor-title'
  titleEl.tabIndex = -1
  const contentEl = el('div', 'tutor-content')
  frameEl.append(titleEl, contentEl)
  rootEl.replaceChildren(frameEl)

  let plan = null
  let lesson = null
  let answers = []
  let position = 0
  let planRequest = 0
  let isStarting = false
  let isSaving = false
  let isSaved = false

  function focus(element) {
    if (!rootEl.hidden && rootEl.contains(document.activeElement)) element.focus()
  }

  function setCard(...nodes) {
    const shouldKeepFocus = contentEl.contains(document.activeElement)
    const cardEl = el('div', 'tutor-card')
    cardEl.append(...nodes)
    contentEl.replaceChildren(cardEl)
    if (shouldKeepFocus) titleEl.focus()
    return cardEl
  }

  function showActionMessage(heading, message, actionEl) {
    const headingEl = el('h3', '', heading)
    const cardEl = setCard(headingEl, el('p', 'tutor-detail', message))
    if (!actionEl) return
    cardEl.append(actionEl)
    headingEl.tabIndex = -1
    focus(headingEl)
  }

  function showPlan(errorMessage = '') {
    const source = plan.source
    if (!source) {
      if (plan.candidateCount === 0) {
        showActionMessage('还没有练习材料', '在翻译工作台查过的英文短语和句子会成为练习材料。')
        return
      }
      const next = Number.isFinite(plan.nextReviewAt) ? new Intl.DateTimeFormat('zh-CN', {
        month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit',
      }).format(plan.nextReviewAt) : ''
      showActionMessage('暂时没有待练习的内容', next ? `下次复练时间是 ${next}。` : '到复练时间会换一句英文再练。')
      return
    }
    const headingEl = el('h3', '', KIND_LABELS[source.kind])
    const reason = source.isReview
      ? '来自查词记录 · 到期复练'
      : source.occurrenceCount > 1 ? `来自查词记录 · 在 ${source.occurrenceCount} 天里查过` : '来自查词记录'
    const cardEl = setCard(headingEl, el('p', 'tutor-detail', reason), englishText('blockquote', 'tutor-source', source.text))
    if (errorMessage) {
      const errorEl = el('p', 'tutor-error', errorMessage)
      errorEl.tabIndex = -1
      cardEl.append(errorEl)
      focus(errorEl)
    }
    if (!plan.isConfigured) {
      cardEl.append(el('p', 'tutor-detail', '启用通用学习模型后就能生成练习。'))
      if (onOpenSettings) cardEl.append(button('打开模型设置', 'tutor-settings', onOpenSettings, 'primary'))
      return
    }
    const actionsEl = el('div', 'tutor-actions')
    actionsEl.append(
      button(source.isReview ? '开始复练' : '开始练习', 'tutor-start', startLesson, 'primary'),
      el('span', 'tutor-detail', '约 2–3 分钟'),
    )
    cardEl.append(actionsEl)
  }

  async function loadPlan(showLoading = true) {
    const request = ++planRequest
    if (showLoading) setCard(el('p', 'tutor-detail', '正在读取查词记录…'))
    try {
      const nextPlan = await api.getPlan()
      if (request !== planRequest) return
      plan = nextPlan
      showPlan()
    } catch {
      if (request !== planRequest) return
      showActionMessage('读取练习计划失败', '可以重新读取本机的查词记录。', button('重试', '', () => void loadPlan()))
    }
  }

  async function startLesson() {
    if (isStarting || !plan?.source || !plan.isConfigured) return
    isStarting = true
    planRequest++
    setCard(el('p', 'tutor-detail', '正在为这条查词记录出题…'))
    try {
      lesson = await api.startLesson(plan.source.id)
      answers = []
      position = 0
      isSaved = false
      renderQuestion()
    } catch (error) {
      lesson = null
      showPlan(lessonError(error))
    } finally {
      isStarting = false
    }
  }

  function renderQuestion() {
    const question = lesson.questions[position]
    const headingEl = el('h3', '', KIND_LABELS[plan.source.kind])
    headingEl.tabIndex = -1
    const counterEl = el('p', 'tutor-detail', `第 ${position + 1} / ${lesson.questions.length} 题`)
    const sentenceEl = englishText('p', 'tutor-sentence', question.sentence)
    const promptEl = el('p', 'tutor-prompt', question.prompt)
    promptEl.id = 'tutor-prompt'
    const optionsEl = el('div', 'tutor-choices')
    optionsEl.setAttribute('role', 'group')
    optionsEl.setAttribute('aria-labelledby', promptEl.id)
    const hintEl = el('p', 'tutor-hint-text', question.hint)
    hintEl.id = 'tutor-hint-text'
    hintEl.hidden = true
    hintEl.tabIndex = -1
    let usedHint = false
    const hintButtonEl = button('看提示', 'tutor-hint', () => {
      hintEl.hidden = !hintEl.hidden
      hintButtonEl.setAttribute('aria-expanded', String(!hintEl.hidden))
      hintButtonEl.textContent = hintEl.hidden ? '看提示' : '收起提示'
      if (hintEl.hidden) return
      usedHint = true
      focus(hintEl)
    })
    hintButtonEl.setAttribute('aria-controls', hintEl.id)
    hintButtonEl.setAttribute('aria-expanded', 'false')

    const cardEl = setCard(counterEl, headingEl, sentenceEl, promptEl, hintButtonEl, hintEl, optionsEl)
    const choicesEl = question.choices.map((choice, index) => button(choice, '', () => {
      if (answers[position]) return
      answers[position] = { correct: index === question.correctIndex, hinted: usedHint }
      hintButtonEl.disabled = true
      for (const [optionIndex, optionEl] of choicesEl.entries()) {
        optionEl.disabled = true
        if (optionIndex === question.correctIndex) optionEl.dataset.result = 'correct'
        else if (optionIndex === index) optionEl.dataset.result = 'incorrect'
      }
      showFeedback(question, cardEl, answers[position])
    }, 'tutor-choice'))
    optionsEl.append(...choicesEl)
    focus(headingEl)
  }

  function showFeedback(question, cardEl, answer) {
    const hasNext = position + 1 < lesson.questions.length
    const feedbackEl = el('div', 'tutor-feedback')
    const headingEl = el('h4', '', answer.correct ? '答对了' : '这句的理解有一点偏差')
    headingEl.tabIndex = -1
    headingEl.id = 'tutor-feedback'
    feedbackEl.dataset.result = answer.correct ? 'correct' : 'incorrect'
    feedbackEl.append(headingEl)
    if (!answer.correct) feedbackEl.append(el('p', 'tutor-correct-answer', `正确答案是 ${question.choices[question.correctIndex]}`))
    feedbackEl.append(el('p', '', question.explanation))
    cardEl.append(feedbackEl, button(hasNext ? '下一题' : '完成练习', 'tutor-next', () => {
      if (hasNext) {
        position++
        renderQuestion()
        return
      }
      void saveResult()
    }, 'primary'))
    if (!rootEl.hidden) headingEl.focus()
  }

  function showSummary(outcome) {
    const headingEl = el('h3', '', '练习完成')
    headingEl.id = 'tutor-summary'
    headingEl.tabIndex = -1
    const numCorrect = answers.filter((answer) => answer.correct).length
    const statusEl = el('div', 'tutor-summary-status')
    statusEl.append(el('p', 'tutor-detail', '正在保存练习结果…'))
    setCard(headingEl, el('p', 'tutor-detail', `本轮主题 ${lesson.topic}`), el('p', '', OUTCOME_LABELS[outcome]),
      el('p', 'tutor-detail', `答对 ${numCorrect} / ${answers.length} 题`), statusEl)
    focus(headingEl)
    return statusEl
  }

  async function saveResult() {
    if (isSaving || isSaved) return
    const outcome = lessonOutcome(answers)
    isSaving = true
    const statusEl = showSummary(outcome)
    try {
      const result = await api.recordResult({
        lessonId: lesson.id,
        sourceId: lesson.sourceId,
        outcome,
        sentences: lesson.questions.map((question) => question.sentence),
      })
      if (result === false) throw new Error('Unable to save lesson result.')
      isSaved = true
      statusEl.replaceChildren(button('查看下一组练习', 'tutor-continue', () => {
        lesson = null
        void loadPlan()
      }, 'primary'))
    } catch {
      const errorEl = el('p', 'tutor-error', '保存练习结果失败，可以重试。')
      errorEl.tabIndex = -1
      statusEl.replaceChildren(errorEl, button('重试保存', 'tutor-retry', saveResult, 'primary'))
      focus(errorEl)
    } finally {
      isSaving = false
    }
  }

  return {
    open() {
      titleEl.focus()
      if (!lesson && !isStarting) void loadPlan()
    },
    refresh() {
      if (!rootEl.hidden && !lesson && !isStarting) void loadPlan(false)
    },
  }
}
