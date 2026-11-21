const KIND_LABELS = { phrase: 'Understand a phrase in context', sentence: 'Understand the whole sentence' }
const OUTCOME_LABELS = {
  independent: 'You understood all the new sentences on your own.',
  hinted: 'You understood the last sentence after a hint or correction.',
  incorrect: 'You’ll practice the same skill in a different context next time.',
}

export function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

export function button(label, id, onClick, className) {
  const node = el('button', className, label)
  node.type = 'button'
  if (id) node.id = id
  node.addEventListener('click', onClick)
  return node
}

export function englishText(tag, className, text) {
  const node = el(tag, className, text)
  node.lang = 'en'
  return node
}

export function coachErrorText(error, fallback) {
  const message = String(error?.message || '').replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '')
  const marker = '[english-coach] '
  return message.startsWith(marker) ? message.slice(marker.length) : fallback
}

function lessonOutcome(answers) {
  if (!answers.at(-1).correct) return 'incorrect'
  return answers.every((answer) => answer.correct && !answer.hinted) ? 'independent' : 'hinted'
}

export function createReviewWorkspace({ rootEl, api, onOpenSettings }) {
  const titleEl = el('h3', 'sr-only', 'Review')
  titleEl.tabIndex = -1
  const contentEl = el('div', 'tutor-content')
  rootEl.append(titleEl, contentEl)

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
    const headingEl = el('h4', '', heading)
    const cardEl = setCard(headingEl, el('p', 'tutor-detail', message))
    if (!actionEl) return
    cardEl.append(actionEl)
    headingEl.tabIndex = -1
    focus(headingEl)
  }

  function showProgress(message) {
    const statusEl = el('p', 'tutor-detail', message)
    statusEl.setAttribute('role', 'status')
    setCard(statusEl)
  }

  function showPlan(errorMessage = '') {
    const source = plan.source
    if (!source) {
      if (plan.candidateCount === 0) {
        showActionMessage('No practice material yet', 'Translate an English phrase or sentence to start building your practice material.')
        return
      }
      const next = Number.isFinite(plan.nextReviewAt) ? new Intl.DateTimeFormat('en', {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      }).format(plan.nextReviewAt) : ''
      showActionMessage('You’re all caught up', next ? `Next review: ${next}` : 'A new sentence will be ready when your next review is due.')
      return
    }
    const headingEl = el('h4', '', KIND_LABELS[source.kind])
    const reason = source.isReview
      ? 'From your translation history · Due for review'
      : source.occurrenceCount > 1 ? `From your translation history · Looked up on ${source.occurrenceCount} different days` : 'From your translation history'
    const cardEl = setCard(headingEl, el('p', 'tutor-detail', reason), englishText('blockquote', 'tutor-source', source.text))
    if (errorMessage) {
      const errorEl = el('p', 'tutor-error', errorMessage)
      errorEl.tabIndex = -1
      cardEl.append(errorEl)
      focus(errorEl)
    }
    if (!plan.isConfigured) {
      cardEl.append(el('p', 'tutor-detail', 'Set up a learning model to generate exercises.'))
      if (onOpenSettings) cardEl.append(button('Open model settings', 'tutor-settings', onOpenSettings, 'primary'))
      return
    }
    const actionsEl = el('div', 'tutor-actions')
    actionsEl.append(
      button(source.isReview ? 'Start review' : 'Start practice', 'tutor-start', startLesson, 'primary'),
      el('span', 'tutor-detail', 'About 2–3 minutes'),
    )
    cardEl.append(actionsEl)
  }

  async function loadPlan(showLoading = true) {
    const request = ++planRequest
    if (showLoading) showProgress('Loading your translation history…')
    try {
      const nextPlan = await api.getPlan()
      if (request !== planRequest) return
      plan = nextPlan
      showPlan()
    } catch {
      if (request !== planRequest) return
      showActionMessage('Couldn’t load your practice plan', 'Try loading your translation history again.', button('Try again', '', () => void loadPlan()))
    }
  }

  async function startLesson() {
    if (isStarting || !plan?.source || !plan.isConfigured) return
    isStarting = true
    planRequest++
    showProgress('Preparing your questions…')
    try {
      lesson = await api.startLesson(plan.source.id)
      answers = []
      position = 0
      isSaved = false
      renderQuestion()
    } catch (error) {
      lesson = null
      showPlan(coachErrorText(error, 'Couldn’t generate the exercise. Try again.'))
    } finally {
      isStarting = false
    }
  }

  function renderQuestion() {
    const question = lesson.questions[position]
    const headingEl = el('h4', '', KIND_LABELS[plan.source.kind])
    headingEl.tabIndex = -1
    const counterEl = el('p', 'tutor-step', `Question ${position + 1} of ${lesson.questions.length}`)
    const questionHead = el('header', 'tutor-question-head')
    questionHead.append(headingEl, counterEl)
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
    const hintButtonEl = button('Show hint', 'tutor-hint', () => {
      hintEl.hidden = !hintEl.hidden
      hintButtonEl.setAttribute('aria-expanded', String(!hintEl.hidden))
      hintButtonEl.textContent = hintEl.hidden ? 'Show hint' : 'Hide hint'
      if (hintEl.hidden) return
      usedHint = true
      focus(hintEl)
    })
    hintButtonEl.setAttribute('aria-controls', hintEl.id)
    hintButtonEl.setAttribute('aria-expanded', 'false')

    const cardEl = setCard(questionHead, sentenceEl, promptEl, hintButtonEl, hintEl, optionsEl)
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
    const headingEl = el('h5', '', answer.correct ? 'Correct' : 'Not quite')
    headingEl.tabIndex = -1
    headingEl.id = 'tutor-feedback'
    feedbackEl.dataset.result = answer.correct ? 'correct' : 'incorrect'
    feedbackEl.append(headingEl)
    if (!answer.correct) feedbackEl.append(el('p', 'tutor-correct-answer', `Correct answer: ${question.choices[question.correctIndex]}`))
    feedbackEl.append(el('p', '', question.explanation))
    cardEl.append(feedbackEl, button(hasNext ? 'Next question' : 'Finish practice', 'tutor-next', () => {
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
    const headingEl = el('h4', '', 'Practice complete')
    headingEl.id = 'tutor-summary'
    headingEl.tabIndex = -1
    const numCorrect = answers.filter((answer) => answer.correct).length
    const statusEl = el('div', 'tutor-summary-status')
    statusEl.append(el('p', 'tutor-detail', 'Saving your results…'))
    setCard(headingEl, el('p', 'tutor-detail', `Topic: ${lesson.topic}`), el('p', '', OUTCOME_LABELS[outcome]),
      el('p', 'tutor-detail', `${numCorrect} of ${answers.length} correct`), statusEl)
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
      statusEl.replaceChildren(button('Next exercise', 'tutor-continue', () => {
        lesson = null
        void loadPlan()
      }, 'primary'))
    } catch {
      const errorEl = el('p', 'tutor-error', 'Couldn’t save your results. Try again.')
      errorEl.tabIndex = -1
      statusEl.replaceChildren(errorEl, button('Retry saving', 'tutor-retry', saveResult, 'primary'))
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
