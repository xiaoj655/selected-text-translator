import { button, el, englishText } from './tutor.js'

const INTRO_RATINGS = [
  ['known', 'Already knew'],
  ['familiar', 'Looks familiar'],
  ['new', 'New to me'],
]
const REVIEW_RATINGS = [
  ['remembered', 'Remembered'],
  ['forgot', 'Forgot'],
]
const reviewDate = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' })

function sessionCount(count, label) {
  const item = el('div', 'vocabulary-count')
  item.append(el('dt', '', label), el('dd', '', String(count)))
  return item
}

export function createVocabularyWorkspace({ rootEl, api }) {
  let isOpen = false
  let planRequest = 0
  let session = null
  let speechId = null
  let speechButton = null
  let speechNotice = null

  function present(heading, ...children) {
    const hadFocus = rootEl.contains(document.activeElement)
    const card = el('div', 'tutor-card vocabulary-card')
    heading.tabIndex = -1
    card.append(...children)
    if (!card.contains(heading)) card.prepend(heading)
    rootEl.replaceChildren(card)
    if (isOpen && hadFocus) heading.focus({ preventScroll: true })
  }

  async function loadPlan(showLoading = true) {
    const request = ++planRequest
    if (showLoading) {
      const loading = el('p', 'tutor-detail', 'Preparing your next practice session…')
      loading.setAttribute('role', 'status')
      present(el('h3', 'reading-heading', 'Vocabulary practice'), loading)
    }
    try {
      const plan = await api.vocabularyPlan()
      if (request !== planRequest || !isOpen) return
      showPlan(plan)
    } catch {
      if (request !== planRequest || !isOpen) return
      present(el('h3', 'reading-heading', 'Vocabulary practice'),
        el('p', 'tutor-error', 'Couldn’t load your next session.'),
        button('Try again', 'vocabulary-retry', () => void loadPlan(), 'primary'))
    }
  }

  function showPlan(plan) {
    const heading = el('h3', 'reading-heading', plan.queue.length ? 'Vocabulary practice' : 'You’re all caught up')
    if (!plan.queue.length) {
      const detail = Number.isFinite(plan.nextReviewAt)
        ? `Your next review is due ${reviewDate.format(plan.nextReviewAt)}.`
        : 'You’ve seen every word in the current word list.'
      present(heading, el('p', 'tutor-detail', detail),
        button('Check again', 'vocabulary-check', () => void loadPlan()))
      return
    }
    const counts = el('dl', 'vocabulary-counts')
    counts.append(sessionCount(plan.newCount, 'New words'), sessionCount(plan.dueCount, 'Due for review'),
      sessionCount('About 5 min', 'Practice time'))
    const remaining = plan.remainingDue > 0 ? [el('p', 'tutor-detail',
      `${plan.remainingDue} more ${plan.remainingDue === 1 ? 'word is' : 'words are'} due after this session.`)] : []
    present(heading, el('p', 'tutor-detail', 'New words and reviews based on what you know and remember.'), counts, ...remaining,
      button('Start practice', 'vocabulary-start', () => {
        ++planRequest
        session = { queue: plan.queue, position: 0, revealed: false, saving: false, error: '' }
        showCard()
      }, 'primary'))
  }

  function showCard() {
    const current = session
    const item = current.queue[current.position]
    const isReview = item.mode === 'review'
    const heading = englishText('h3', 'vocabulary-word', item.word)
    heading.id = 'vocabulary-word'
    speechButton = button('Read aloud', 'vocabulary-speak', () => void toggleSpeech(item.word))
    speechNotice = el('p', 'tutor-detail vocabulary-speech-status')
    speechNotice.setAttribute('role', 'status')
    updateSpeech()

    const progress = el('progress', 'vocabulary-progress')
    progress.max = current.queue.length
    progress.value = current.position + 1
    progress.setAttribute('aria-label', 'Session progress')
    const progressLabel = el('p', 'tutor-step', `Word ${current.position + 1} of ${current.queue.length}`)
    const source = item.fromHistory ? ' · From your lookups' : ''

    const answer = el('div', 'vocabulary-answer')
    answer.id = 'vocabulary-answer'
    answer.hidden = !current.revealed
    answer.tabIndex = -1
    const meaning = el('p', 'vocabulary-meaning', item.meaning)
    meaning.id = 'vocabulary-meaning'
    answer.append(meaning)
    if (item.example) answer.append(englishText('p', 'tutor-detail', item.example))

    const ratings = el('div', 'tutor-actions vocabulary-ratings')
    ratings.hidden = !current.revealed
    ratings.setAttribute('role', 'group')
    ratings.setAttribute('aria-label', 'Rate your recall')
    const feedback = el('p', 'tutor-error vocabulary-rating-status', current.error)
    feedback.setAttribute('role', 'status')
    const choices = isReview ? REVIEW_RATINGS : INTRO_RATINGS
    for (const [rating, label] of choices) {
      const choice = button(label, '', () => void rate(current, item, rating))
      choice.dataset.vocabularyRating = rating
      if (current.saving) choice.setAttribute('aria-disabled', 'true')
      ratings.append(choice)
    }

    const prompt = el('p', 'tutor-detail', 'Try to recall the meaning before you reveal it.')
    prompt.hidden = current.revealed
    const reveal = button('Show meaning', 'vocabulary-reveal', () => {
      current.revealed = true
      prompt.hidden = true
      reveal.hidden = true
      answer.hidden = false
      ratings.hidden = false
      answer.focus({ preventScroll: true })
    }, 'primary')
    reveal.hidden = current.revealed
    reveal.setAttribute('aria-controls', answer.id)

    const wordRow = el('div', 'vocabulary-word-row')
    wordRow.append(heading, speechButton)
    const header = el('div', 'tutor-question-head vocabulary-question-head')
    header.append(progressLabel, el('p', 'tutor-step', `${isReview ? 'Review' : 'New word'}${source}`))
    present(heading, header, progress, wordRow, speechNotice, prompt, reveal, answer, ratings, feedback)
  }

  async function rate(current, item, rating) {
    if (!current.revealed || current.saving) return
    current.saving = true
    current.error = ''
    rootEl.querySelector('.vocabulary-rating-status').textContent = ''
    for (const choice of rootEl.querySelectorAll('[data-vocabulary-rating]')) choice.setAttribute('aria-disabled', 'true')
    try {
      const acknowledgment = await api.vocabularyRate({ word: item.word, rating })
      if (acknowledgment === false) throw new Error('Unable to save the rating')
      stopSpeech()
      current.position++
      current.revealed = false
    } catch {
      current.error = 'Couldn’t save this rating. Choose it again to retry.'
    } finally {
      current.saving = false
    }
    if (isOpen) showSession()
  }

  function showSession() {
    if (session.position < session.queue.length) {
      showCard()
      return
    }
    const heading = el('h3', 'reading-heading', 'Practice complete')
    heading.id = 'vocabulary-summary'
    const count = session.queue.length
    present(heading, el('p', 'tutor-detail', `${count} ${count === 1 ? 'word' : 'words'} practiced.`),
      button('Check next session', 'vocabulary-next-session', () => {
        session = null
        void loadPlan()
      }, 'primary'))
  }

  function updateSpeech(message = '') {
    if (speechButton) speechButton.textContent = speechId ? 'Stop reading' : 'Read aloud'
    if (speechNotice) speechNotice.textContent = message
  }

  function stopSpeech() {
    if (!speechId) return
    const activeId = speechId
    speechId = null
    updateSpeech()
    void chrome.runtime.sendMessage({ type: 'STOP_SPEECH', payload: { speechId: activeId } }).catch(() => {})
  }

  async function toggleSpeech(word) {
    if (speechId) { stopSpeech(); return }
    const activeId = `vocabulary-${crypto.randomUUID()}`
    speechId = activeId
    updateSpeech()
    try {
      const response = await chrome.runtime.sendMessage({ type: 'SPEAK_TEXT', payload: {
        speechId: activeId, text: word, language: 'en-US',
      } })
      if (!response?.ok) throw new Error('Unable to play speech')
    } catch {
      if (speechId !== activeId) return
      speechId = null
      updateSpeech('Speech unavailable.')
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'SPEECH_EVENT' || !speechId || message.payload?.speechId !== speechId) return
    const { status, message: detail } = message.payload
    if (status === 'fallback') updateSpeech(detail)
    if (!['end', 'error', 'interrupted', 'cancelled'].includes(status)) return
    speechId = null
    updateSpeech(status === 'error' ? detail || 'Speech unavailable.' : '')
  })

  return {
    open() {
      isOpen = true
      if (session) showSession()
      else void loadPlan()
    },
    close() {
      isOpen = false
      ++planRequest
      stopSpeech()
    },
    refresh() {
      if (isOpen && !session) void loadPlan(false)
    },
  }
}
