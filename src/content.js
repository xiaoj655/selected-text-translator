(() => {
  const TRANSLATION_MESSAGE_TYPES = {
    START_TRANSLATION: 'START_TRANSLATION',
    TRANSLATION_EVENT: 'TRANSLATION_EVENT'
  };

  const TRANSLATION_EVENT_STATUS = {
    STARTED: 'started',
    STREAM: 'stream',
    SUCCESS: 'success',
    MISSING_CONFIGURATION: 'missing-configuration',
    ERROR: 'error'
  };

  const HOVER_DELAY_MS = 150;
  const PLACEMENT_GAP_PX = 10;
  const DEFAULT_CARD_WIDTH_PX = 360;
  const MIN_CARD_WIDTH_PX = 220;
  const MAX_CARD_WIDTH_PX = 720;
  const MIN_CARD_HEIGHT_PX = 110;
  const CARD_WIDTH_STORAGE_KEY = 'translation_card_width_px';
  const TRIGGER_SIZE_PX = 28;
  const VIEWPORT_MARGIN_PX = 8;
  const LOG_PREFIX = '[selected-text-translation]';
  const DEBUG_LOGGING_KEY = 'debug_logging_enabled';
  const DISABLED_URL_PATTERNS_KEY = 'disabled_url_patterns';
  let debugLoggingEnabled = false;
  let urlBlacklist = [];

  const state = {
    mode: 'translate',
    defaultMode: 'translate',
    canFetchPhonetic: false,
    uiRoot: null,
    settingsReady: null,
    speechId: null,
    speechTarget: '',
    speechMessage: '',
    viewportFrame: null,
    selectionCounter: 0,
    requestCounter: 0,
    activeSelection: null,
    activeRequest: null,
    triggerEl: null,
    cardEl: null,
    cardWidthPx: DEFAULT_CARD_WIDTH_PX,
    cardResizeSession: null,
    cardWidthPersistQueue: Promise.resolve(),
    hoverTimerId: null,
    pendingSelectionScan: false
  };

  ensureStyles();
  void initDebugLoggingSetting();
  void initCardWidthSetting();
  void initUrlBlacklistSetting();
  state.settingsReady = initReadingMode();
  bindListeners();

  function bindListeners() {
    document.addEventListener('selectionchange', scheduleSelectionScan, true);
    document.addEventListener('mousedown', handleDocumentMouseDown, true);
    document.addEventListener('scroll', scheduleViewportUpdate, true);
    window.addEventListener('resize', scheduleViewportUpdate);
    window.addEventListener('pagehide', () => { cancelActiveRequest(); stopSpeech(); });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.cardEl) {
        removeCard();
        state.triggerEl?.focus({ preventScroll: true });
      }
    }, true);

    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === 'OPEN_READING_ASSISTANT') {
        refreshSelection();
        if (state.activeSelection) void startTranslationRequest().then(() => {
          state.cardEl?.querySelector('.stt-tab[aria-pressed="true"]')?.focus({ preventScroll: true });
        });
        return;
      }
      if (message?.type === 'SPEECH_EVENT') {
        handleSpeechEvent(message.payload || {});
        return;
      }
      if (!message || message.type !== TRANSLATION_MESSAGE_TYPES.TRANSLATION_EVENT) {
        return;
      }
      handleTranslationEvent(message.payload || {});
    });
  }

  function scheduleSelectionScan() {
    if (state.pendingSelectionScan) {
      return;
    }

    state.pendingSelectionScan = true;
    queueMicrotask(() => {
      state.pendingSelectionScan = false;
      refreshSelection();
    });
  }

  function refreshSelection() {
    if (isUrlBlacklisted()) {
      clearActiveSelection('url_blacklisted');
      return;
    }

    const selection = window.getSelection();
    if (selection?.anchorNode && state.cardEl?.contains(selection.anchorNode)) return;
    if (!selection || selection.rangeCount === 0) {
      clearActiveSelection('selection_empty');
      return;
    }

    const rawText = selection.toString();
    const text = rawText.trim();
    if (!text) {
      clearActiveSelection('selection_empty');
      return;
    }

    const range = selection.getRangeAt(0);
    if (!range || range.collapsed || !isSupportedSelectionRange(range)) {
      clearActiveSelection('selection_unsupported');
      return;
    }

    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      clearActiveSelection('selection_no_rect');
      return;
    }

    const triggerRect = getTriggerAnchorRect(range, rect);
    const fingerprint = buildSelectionFingerprint(text, rect, triggerRect);
    const existing = state.activeSelection;
    if (existing && existing.fingerprint === fingerprint) {
      positionTrigger(existing.triggerRect || existing.rect);
      if (state.cardEl) {
        positionCard(existing.rect);
      }
      return;
    }

    const selectionId = makeSelectionId();
    cancelActiveRequest();
    state.mode = state.defaultMode;
    state.activeSelection = {
      id: selectionId,
      text,
      range: range.cloneRange(),
      ...getSelectionContext(range),
      savedVocabulary: {},
      cache: {},
      hintCount: 1,
      answerRevealed: false,
      rect: cloneRect(rect),
      triggerRect: cloneRect(triggerRect),
      fingerprint
    };

    clearHoverTimer();
    ensureTrigger();
    positionTrigger(state.activeSelection.triggerRect);
    removeCard();

    debugLog('selection_changed', {
      selectionId,
      selectedText: createSelectedTextDiagnostics(text)
    });
  }

  function isSupportedSelectionRange(range) {
    const container =
      range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;

    if (!container || !document.body.contains(container)) {
      return false;
    }

    const blockedContainer = container.closest(
      'input, textarea, [contenteditable], .stt-trigger, .stt-card'
    );
    if (!blockedContainer) {
      return true;
    }

    if (blockedContainer.matches('.stt-trigger, .stt-card')) {
      return false;
    }

    if (blockedContainer.matches('input, textarea')) {
      return false;
    }

    const editable = blockedContainer.getAttribute('contenteditable');
    return editable === 'false';
  }

  function ensureTrigger() {
    if (state.triggerEl) {
      return;
    }

    const trigger = document.createElement('button');
    trigger.className = 'stt-trigger';
    trigger.type = 'button';
    trigger.textContent = 'Aa';
    trigger.setAttribute('aria-label', 'Open reading assistant');
    trigger.title = 'Translate or explore this selection';

    trigger.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    trigger.addEventListener('mouseenter', onTriggerHoverStart);
    trigger.addEventListener('mouseleave', onTriggerHoverEnd);
    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      clearHoverTimer();
      void startTranslationRequest();
    });

    state.uiRoot.appendChild(trigger);
    state.triggerEl = trigger;
  }

  function positionTrigger(selectionRect) {
    if (!state.triggerEl) {
      return;
    }

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const preferredLeft = selectionRect.right + PLACEMENT_GAP_PX;
    const preferredTop = selectionRect.bottom + PLACEMENT_GAP_PX;

    const left = clamp(
      preferredLeft,
      VIEWPORT_MARGIN_PX,
      viewportWidth - TRIGGER_SIZE_PX - VIEWPORT_MARGIN_PX
    );
    const top = clamp(
      preferredTop,
      VIEWPORT_MARGIN_PX,
      viewportHeight - TRIGGER_SIZE_PX - VIEWPORT_MARGIN_PX
    );

    state.triggerEl.style.left = `${left}px`;
    state.triggerEl.style.top = `${top}px`;
    state.triggerEl.style.display = 'block';
  }

  function getTriggerAnchorRect(range, fallbackRect) {
    const lastRect = getLastNonEmptyClientRect(range);
    if (lastRect) {
      return cloneRect(lastRect);
    }
    return cloneRect(fallbackRect);
  }

  function getLastNonEmptyClientRect(range) {
    if (!range || typeof range.getClientRects !== 'function') {
      return null;
    }

    const rects = Array.from(range.getClientRects());
    for (let index = rects.length - 1; index >= 0; index -= 1) {
      const rect = rects[index];
      if (!rect) {
        continue;
      }
      if (rect.width === 0 && rect.height === 0) {
        continue;
      }
      return rect;
    }
    return null;
  }

  function onTriggerHoverStart() {
    if (!state.activeSelection) {
      return;
    }

    const running =
      state.activeRequest &&
      state.activeRequest.selectionId === state.activeSelection.id &&
      state.activeRequest.inFlight;
    if (running) {
      return;
    }

    clearHoverTimer();
    state.hoverTimerId = window.setTimeout(() => {
      state.hoverTimerId = null;
      startTranslationRequest();
    }, HOVER_DELAY_MS);

    debugLog('hover_start', {
      selectionId: state.activeSelection.id
    });
  }

  function onTriggerHoverEnd() {
    if (!state.activeSelection) {
      return;
    }

    if (state.hoverTimerId !== null) {
      clearHoverTimer();
      debugLog('hover_cancel', {
        selectionId: state.activeSelection.id
      });
    }
  }

  async function startTranslationRequest(kind) {
    const selectionId = state.activeSelection?.id
    try {
      await state.settingsReady
      if (!selectionId || state.activeSelection?.id !== selectionId) return
      if (isUrlBlacklisted()) { clearActiveSelection('url_blacklisted'); return }
      kind = kind || state.mode
      if (kind === 'pronunciation') state.activeSelection.pronunciationError = ''
      const cached = state.activeSelection.cache[kind]
      if (cached) {
        renderCurrentCard()
        return
      }
      if (state.activeRequest?.inFlight && state.activeRequest.kind === kind) return
      cancelActiveRequest()
      const requestId = makeRequestId()
      state.activeRequest = { selectionId, requestId, kind, inFlight: true }
      state.speechMessage = ''
      if (kind === 'pronunciation' && state.activeSelection.cache[state.mode]) renderCurrentCard()
      else renderLoadingCard(kind === 'guide' ? 'Finding a way into this passage…' : 'Translating…')
      debugLog('request_start', { selectionId, requestId,
        selectedText: createSelectedTextDiagnostics(state.activeSelection.text) })
      chrome.runtime.sendMessage({
        type: TRANSLATION_MESSAGE_TYPES.START_TRANSLATION,
        payload: { selectionId, requestId, kind, text: state.activeSelection.text,
          context: state.activeSelection.context,
          contextStart: state.activeSelection.contextStart, contextEnd: state.activeSelection.contextEnd },
      }, (response) => {
        const error = chrome.runtime.lastError
        if ((error || !response?.accepted) && state.activeRequest?.requestId === requestId) {
          state.activeRequest.inFlight = false
          renderStatusCard('Connection lost. Reload this webpage and try again.')
        }
      })
    } catch {
      if (state.activeSelection?.id === selectionId) {
        if (state.activeRequest) state.activeRequest.inFlight = false
        renderStatusCard('Unable to start. Reload this webpage and try again.')
      }
    }
  }

  function cancelActiveRequest() {
    const active = state.activeRequest
    state.activeRequest = null
    if (!active?.inFlight) return
    try {
      chrome.runtime.sendMessage({ type: 'CANCEL_TRANSLATION', payload: { requestId: active.requestId } },
        () => { void chrome.runtime.lastError })
    } catch { }
  }

  function selectMode(mode) {
    if (state.mode === mode) return
    cancelActiveRequest()
    state.mode = mode
    state.defaultMode = mode
    state.activeSelection.notice = ''
    try {
      void chrome.storage.sync.set({ reading_mode: mode }).catch(() => {})
    } catch { }
    void startTranslationRequest(mode)
  }

  function handleTranslationEvent(payload) {
    const status = payload.status;
    const selectionId = String(payload.selectionId || '');
    const requestId = String(payload.requestId || '');

    if (!state.activeSelection || selectionId !== state.activeSelection.id) {
      debugLog('stale_event_ignored', {
        selectionId,
        requestId,
        status
      });
      return;
    }

    if (!state.activeRequest || requestId !== state.activeRequest.requestId) {
      debugLog('stale_event_ignored', {
        selectionId,
        requestId,
        status
      });
      return;
    }

    if (typeof payload.contextSentence === 'string') state.activeSelection.contextSentence = payload.contextSentence;

    if (status === TRANSLATION_EVENT_STATUS.STARTED) {
      if (state.activeRequest.kind === 'pronunciation' && state.activeSelection.cache[state.mode]) renderCurrentCard();
      else renderLoadingCard(state.activeRequest.kind === 'guide' ? 'Finding contextual clues…' : 'Translating…');
      return;
    }

    if (status === TRANSLATION_EVENT_STATUS.STREAM) {
      const partial = String(payload.translatedText || '').trim();
      if (partial) {
        renderSuccessCard(state.activeSelection.text, partial, null);
        debugLog('stream_progress', {
          selectionId,
          requestId,
          translatedLength: partial.length
        });
      }
      return;
    }

    state.activeRequest.inFlight = false;

    if (status === TRANSLATION_EVENT_STATUS.SUCCESS) {
      if (payload.kind === 'guide' || payload.kind === 'pronunciation') {
        state.activeSelection.cache[payload.kind] = payload.result;
        renderCurrentCard();
        return;
      }
      state.activeSelection.cache[state.mode] = payload;
      const translatedText = String(payload.translatedText || '').trim();
      if (translatedText) {
        const lexicalDetails = normalizeLexicalDetails(payload.lexicalDetails);
        renderSuccessCard(state.activeSelection.text, translatedText, lexicalDetails);
        if (state.canFetchPhonetic && isSingleWordInput(state.activeSelection.text)
          && !lexicalDetails?.phonetic && !state.activeSelection.cache.guide?.phonetic
          && !state.activeSelection.cache.pronunciation) {
          void startTranslationRequest('pronunciation');
        }
        debugLog('request_success', {
          selectionId,
          requestId,
          translatedLength: translatedText.length,
          lexicalFields: summarizeLexicalDetails(lexicalDetails)
        });
      } else {
        renderStatusCard('Translation returned no text.');
      }
      return;
    }

    if (status === TRANSLATION_EVENT_STATUS.MISSING_CONFIGURATION) {
      if (keepTranslationOnPronunciationError(payload.message)) return;
      renderStatusCard(payload.message || 'Open settings to connect a model.');
      debugLog('missing_configuration', {
        selectionId,
        requestId
      });
      return;
    }

    if (status === TRANSLATION_EVENT_STATUS.ERROR) {
      const message = String(payload.message || 'Translation failed.').trim();
      if (keepTranslationOnPronunciationError(message)) return;
      renderStatusCard(message || 'Translation failed.');
      debugLog('request_error', {
        selectionId,
        requestId,
        messageLength: message.length
      });
    }
  }

  function keepTranslationOnPronunciationError(message) {
    if (state.activeRequest?.kind !== 'pronunciation' || !state.activeSelection.cache[state.mode]) return false
    state.activeSelection.pronunciationError = message || 'Unable to load phonetics. Try again.'
    renderCurrentCard()
    return true
  }

  function createEl(tag, className, text) {
    const el = document.createElement(tag)
    if (className) el.className = className
    if (text !== undefined) el.textContent = text
    return el
  }

  function createButton(label, handler, className = 'stt-button') {
    const buttonEl = createEl('button', className, label)
    buttonEl.type = 'button'
    buttonEl.addEventListener('click', (event) => {
      event.stopPropagation()
      handler()
    })
    return buttonEl
  }

  function renderFrame() {
    const cardEl = ensureCard()
    cardEl.className = 'stt-card stt-card--result'
    cardEl.replaceChildren()
    const toolbarEl = createEl('div', 'stt-toolbar')
    const tabsEl = createEl('div', 'stt-tabs')
    tabsEl.setAttribute('role', 'group')
    tabsEl.setAttribute('aria-label', 'Reading mode')
    for (const [mode, label] of [['translate', '翻译'], ['guide', '引导理解']]) {
      const tabEl = createButton(label, () => selectMode(mode), 'stt-tab')
      tabEl.setAttribute('aria-pressed', String(state.mode === mode))
      tabsEl.appendChild(tabEl)
    }
    const closeEl = createButton('×', () => {
      removeCard()
      state.triggerEl?.focus({ preventScroll: true })
    }, 'stt-close')
    closeEl.setAttribute('aria-label', 'Close reading card')
    closeEl.title = 'Close · Esc'
    toolbarEl.append(tabsEl, closeEl)
    const sourceEl = createEl('div', 'stt-card-block stt-card-block--source')
    const textEl = createEl('div', 'stt-source-text', state.activeSelection.text)
    if (state.activeSelection.text.length > 80) textEl.classList.add('stt-source-text--passage')
    sourceEl.appendChild(textEl)
    const soundRowEl = createEl('div', 'stt-sound-row')
    const speechEl = createButton(state.speechId && state.speechTarget === 'selection' ? '■ 停止' : '▷ 朗读',
      () => toggleSpeech('selection'), 'stt-speak')
    speechEl.setAttribute('aria-pressed', String(Boolean(state.speechId && state.speechTarget === 'selection')))
    soundRowEl.appendChild(speechEl)
    if (state.activeSelection.contextSentence) {
      const contextSpeechEl = createButton(state.speechId && state.speechTarget === 'context' ? '■ 停止原句' : '▷ 读原句',
        () => toggleSpeech('context'), 'stt-speak-context stt-speak')
      contextSpeechEl.title = state.activeSelection.contextSentence
      contextSpeechEl.setAttribute('aria-pressed', String(Boolean(state.speechId && state.speechTarget === 'context')))
      soundRowEl.appendChild(contextSpeechEl)
    }
    const cache = state.activeSelection.cache
    const phonetic = cache.pronunciation?.phonetic || cache.guide?.phonetic || cache.translate?.lexicalDetails?.phonetic
    if (phonetic) soundRowEl.appendChild(createEl('span', 'stt-phonetic', phonetic))
    else if (isSingleWordInput(state.activeSelection.text)) {
      const phoneticEl = createButton(state.activeRequest?.kind === 'pronunciation' && state.activeRequest.inFlight
        ? '获取音标…' : '查看音标', () => void startTranslationRequest('pronunciation'), 'stt-text-button')
      phoneticEl.disabled = Boolean(state.activeRequest?.inFlight)
      soundRowEl.appendChild(phoneticEl)
    }
    sourceEl.appendChild(soundRowEl)
    const speechStatusEl = createEl('div', 'stt-speech-status', state.speechMessage || state.activeSelection.pronunciationError || '')
    speechStatusEl.setAttribute('role', 'status')
    sourceEl.appendChild(speechStatusEl)
    cardEl.append(toolbarEl, sourceEl)
    return cardEl
  }

  function finishCard() {
    ensureCardResizeHandle();
    positionCard(state.activeSelection.rect)
  }

  function renderLoadingCard(message) {
    const cardEl = renderFrame()
    const statusEl = createEl('div', 'stt-card-block stt-loading', message)
    statusEl.setAttribute('role', 'status')
    cardEl.appendChild(statusEl)
    finishCard()
  }

  function renderStatusCard(message) {
    const cardEl = renderFrame()
    cardEl.appendChild(createEl('div', 'stt-card-block stt-error', message))
    const actionsEl = createEl('div', 'stt-actions')
    actionsEl.append(
      createButton('重试', () => void startTranslationRequest(state.activeRequest?.kind)),
      createButton('打开设置 ↗', () => {
        try {
          chrome.runtime.sendMessage({ type: 'OPEN_SETTINGS' }, () => { void chrome.runtime.lastError })
        } catch { }
      }, 'stt-text-button'),
    )
    cardEl.appendChild(actionsEl)
    finishCard()
  }

  function renderSuccessCard(sourceText, translatedText, lexicalDetails) {
    const existingEl = state.cardEl?.querySelector('.stt-card-block--translation')
    if (existingEl && state.activeRequest?.inFlight && !lexicalDetails) {
      existingEl.textContent = translatedText
      positionCard(state.activeSelection.rect)
      return
    }
    const cardEl = renderFrame()
    cardEl.appendChild(createEl('div', 'stt-section-label', 'TRANSLATION'))
    const translationEl = createEl('div', 'stt-card-block stt-card-block--translation', translatedText)
    cardEl.appendChild(translationEl)
    const lexicalBlock = buildLexicalBlock(sourceText, lexicalDetails)
    if (lexicalBlock) cardEl.appendChild(lexicalBlock)
    if (!state.activeRequest?.inFlight) appendVocabularyActions(cardEl)
    finishCard()
  }

  function renderCurrentCard() {
    const selection = state.activeSelection
    if (!selection) return
    if (state.mode === 'guide' && selection.cache.guide) {
      renderGuideCard(selection.cache.guide)
      return
    }
    const translated = selection.cache.translate
    if (translated && state.mode === 'translate') {
      renderSuccessCard(selection.text, translated.translatedText, translated.lexicalDetails)
      return
    }
    renderStatusCard('Ready when you are. Choose a mode to continue.')
  }

  function renderGuideCard(guide) {
    const selection = state.activeSelection
    const cardEl = renderFrame()
    const headingEl = createEl('div', 'stt-guide-heading')
    headingEl.append(createEl('span', 'stt-section-label', 'READ BETWEEN THE LINES'),
      createEl('span', 'stt-progress', `${selection.hintCount} / ${guide.hints.length}`))
    cardEl.appendChild(headingEl)
    const hintsEl = createEl('div', 'stt-hints')
    hintsEl.setAttribute('aria-live', 'polite')
    guide.hints.slice(0, selection.hintCount).forEach((hint, index) => {
      const hintEl = createEl('div', 'stt-hint')
      hintEl.append(createEl('span', 'stt-hint-number', String(index + 1)), createEl('p', '', hint))
      hintsEl.appendChild(hintEl)
    })
    cardEl.appendChild(hintsEl)
    const actionsEl = createEl('div', 'stt-actions')
    if (selection.hintCount < guide.hints.length) {
      const nextEl = createButton('再提示一点 →', () => {
        selection.hintCount += 1
        renderGuideCard(guide)
        state.cardEl.querySelector('.stt-next-hint, .stt-reveal')?.focus({ preventScroll: true })
      })
      nextEl.classList.add('stt-next-hint')
      actionsEl.appendChild(nextEl)
    }
    if (!selection.answerRevealed) {
      const revealEl = createButton('揭晓答案', () => {
        selection.answerRevealed = true
        renderGuideCard(guide)
        const answerEl = state.cardEl.querySelector('.stt-answer')
        answerEl?.focus({ preventScroll: true })
        answerEl?.scrollIntoView({ block: 'nearest' })
      }, 'stt-text-button stt-reveal')
      actionsEl.appendChild(revealEl)
    }
    cardEl.appendChild(actionsEl)
    if (selection.answerRevealed) {
      const answerEl = createEl('section', 'stt-answer')
      answerEl.tabIndex = -1
      answerEl.setAttribute('aria-label', 'Revealed answer')
      answerEl.append(createEl('div', 'stt-section-label', 'NOW IT MAKES SENSE'),
        createEl('p', 'stt-meaning', guide.answer.meaning),
        createEl('p', 'stt-explanation', guide.answer.explanation),
        createEl('div', 'stt-section-label', 'ANOTHER WAY TO USE IT'),
        createEl('p', 'stt-example', guide.answer.example))
      if (guide.answer.usage) answerEl.appendChild(createEl('p', 'stt-usage', guide.answer.usage))
      cardEl.appendChild(answerEl)
    }
    if (selection.answerRevealed) appendVocabularyActions(cardEl)
    if (selection.context) {
      const contextEl = createEl('details', 'stt-context')
      contextEl.append(createEl('summary', '', '查看参考上下文'), createEl('p', '', selection.context))
      cardEl.appendChild(contextEl)
    }
    finishCard()
  }

  function getVocabularyValue() {
    const selection = state.activeSelection
    if (!selection || selection.text.length > 12000) return null
    const guide = selection.cache.guide
    const translated = selection.cache.translate
    if (state.mode === 'guide' && !selection.answerRevealed) return null
    const meaning = state.mode === 'guide' ? guide?.answer?.meaning : translated?.translatedText
    if (!meaning) return null
    return {
      text: selection.text,
      context: selection.context,
      meaning,
      explanation: state.mode === 'guide' ? guide?.answer?.explanation : '',
      example: state.mode === 'guide' ? guide?.answer?.example : '',
      phonetic: selection.cache.pronunciation?.phonetic || guide?.phonetic || translated?.lexicalDetails?.phonetic || '',
      sourceUrl: window.location.origin + window.location.pathname,
    }
  }

  function appendVocabularyActions(cardEl) {
    const value = getVocabularyValue()
    if (!value) return
    const key = JSON.stringify([value.text.toLowerCase(), value.meaning.toLowerCase()])
    const status = state.activeSelection.savedVocabulary[key]
    const actionsEl = createEl('div', 'stt-actions stt-vocabulary-actions')
    const saveEl = createButton(status === 'saved' ? '✓ 已收藏' : status === 'saving' ? '保存中…' : '＋ 收藏表达',
      () => void saveCurrentVocabulary(value, key), 'stt-save stt-text-button')
    saveEl.disabled = status === 'saving' || status === 'saved'
    const libraryEl = createButton('表达本 ↗', () => {
      try { chrome.runtime.sendMessage({ type: 'OPEN_LIBRARY' }, () => { void chrome.runtime.lastError }) }
      catch { }
    }, 'stt-text-button')
    actionsEl.append(saveEl, libraryEl)
    cardEl.appendChild(actionsEl)
    if (status === 'error') {
      const messageEl = createEl('div', 'stt-save-status', '未能收藏，请重试。')
      messageEl.setAttribute('role', 'status')
      cardEl.appendChild(messageEl)
    }
  }

  async function saveCurrentVocabulary(value, key) {
    const selection = state.activeSelection
    if (!selection || selection.savedVocabulary[key] === 'saving') return
    selection.savedVocabulary[key] = 'saving'
    renderCurrentCard()
    try {
      const response = await chrome.runtime.sendMessage({ type: 'VOCABULARY_SAVE', payload: value })
      selection.savedVocabulary[key] = response?.ok ? 'saved' : 'error'
    } catch {
      selection.savedVocabulary[key] = 'error'
    }
    if (state.activeSelection === selection && state.cardEl) renderCurrentCard()
  }

  function toggleSpeech(target = 'selection') {
    if (state.speechId && state.speechTarget === target) {
      stopSpeech()
      updateSpeechControls()
      return
    }
    if (state.speechId) stopSpeech()
    const text = target === 'context' ? state.activeSelection.contextSentence : state.activeSelection.text
    if (!text) return
    const speechId = `speech-${Date.now()}-${state.activeSelection.id}`
    state.speechTarget = target
    state.speechId = speechId
    state.speechMessage = ''
    updateSpeechControls()
    try {
      chrome.runtime.sendMessage({ type: 'SPEAK_TEXT', payload: { speechId, text } },
        (response) => {
          const error = chrome.runtime.lastError
          if (state.speechId !== speechId) return
          if (error || !response?.ok) {
            state.speechId = null
            state.speechMessage = response?.message || 'Speech unavailable. Reload this webpage and check system voices.'
            updateSpeechControls()
          }
        })
    } catch {
      state.speechId = null
      state.speechMessage = 'Speech unavailable. Reload this webpage and try again.'
      updateSpeechControls()
    }
  }

  function handleSpeechEvent(payload) {
    if (payload.speechId !== state.speechId) return
    if (['end', 'error', 'interrupted', 'cancelled'].includes(payload.status)) {
      state.speechId = null
      state.speechMessage = payload.message || ''
      updateSpeechControls()
    }
  }

  function updateSpeechControls() {
    for (const [selector, target, idleLabel, activeLabel] of [
      ['.stt-speak:not(.stt-speak-context)', 'selection', '▷ 朗读', '■ 停止'],
      ['.stt-speak-context', 'context', '▷ 读原句', '■ 停止原句'],
    ]) {
      const buttonEl = state.cardEl?.querySelector(selector)
      if (!buttonEl) continue
      const isActive = Boolean(state.speechId && state.speechTarget === target)
      buttonEl.textContent = isActive ? activeLabel : idleLabel
      buttonEl.setAttribute('aria-pressed', String(isActive))
    }
    const statusEl = state.cardEl?.querySelector('.stt-speech-status')
    if (statusEl) statusEl.textContent = state.speechMessage || state.activeSelection?.pronunciationError || ''
  }

  function stopSpeech() {
    state.speechTarget = ''
    const speechId = state.speechId
    state.speechId = null
    state.speechMessage = ''
    if (!speechId) return
    try {
      chrome.runtime.sendMessage({ type: 'STOP_SPEECH', payload: { speechId } }, () => { void chrome.runtime.lastError })
    } catch { }
  }

  function buildLexicalBlock(sourceText, lexicalDetails) {
    if (!isSingleWordInput(sourceText)) {
      return null;
    }

    const normalized = normalizeLexicalDetails(lexicalDetails);
    if (!normalized) {
      return null;
    }

    const lexicalBlock = document.createElement('div');
    lexicalBlock.className = 'stt-card-block stt-card-block--lexical';
    let hasContent = false;

    if (Array.isArray(normalized.definitions) && normalized.definitions.length > 0) {
      lexicalBlock.append(createDefinitionsSection(normalized.definitions));
      hasContent = true;
    }

    if (normalized.contextual_analysis) {
      lexicalBlock.append(createLexicalRow('Context', normalized.contextual_analysis));
      hasContent = true;
    }

    return hasContent ? lexicalBlock : null;
  }

  function createLexicalRow(label, value) {
    const row = document.createElement('div');
    row.className = 'stt-lexical-row';

    const labelEl = document.createElement('span');
    labelEl.className = 'stt-lexical-label';
    labelEl.textContent = `${label}:`;

    const valueEl = document.createElement('span');
    valueEl.className = 'stt-lexical-value';
    valueEl.textContent = value;

    row.append(labelEl, valueEl);
    return row;
  }

  function createDefinitionsSection(definitions) {
    const wrapper = document.createElement('div');
    wrapper.className = 'stt-lexical-row stt-lexical-row--definitions';

    const labelEl = document.createElement('span');
    labelEl.className = 'stt-lexical-label';
    labelEl.textContent = 'Definitions:';

    const list = document.createElement('ul');
    list.className = 'stt-definition-list';
    for (const definition of definitions) {
      const item = document.createElement('li');
      item.className = 'stt-definition-item';

      const parts = [];
      if (definition.pos) {
        parts.push(`[${definition.pos}]`);
      }
      parts.push(definition.meaning);

      if (definition.example) {
        parts.push(`(${definition.example.source} -> ${definition.example.target})`);
      }

      item.textContent = parts.join(' ');
      list.append(item);
    }

    wrapper.append(labelEl, list);
    return wrapper;
  }

  function normalizeLexicalDetails(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const normalized = {};
    const phonetic = normalizeOptionalString(value.phonetic);
    if (phonetic) {
      normalized.phonetic = phonetic;
    }

    const definitions = normalizeDefinitions(value.definitions);
    if (definitions) {
      normalized.definitions = definitions;
    }

    const contextualAnalysis = normalizeOptionalString(
      value.contextual_analysis ?? value.contextualAnalysis
    );
    if (contextualAnalysis) {
      normalized.contextual_analysis = contextualAnalysis;
    }

    return Object.keys(normalized).length > 0 ? normalized : null;
  }

  function normalizeDefinitions(value) {
    if (!Array.isArray(value) || value.length === 0) {
      return null;
    }

    const normalized = [];
    for (const item of value) {
      const normalizedItem = normalizeDefinitionItem(item);
      if (normalizedItem) {
        normalized.push(normalizedItem);
      }
    }

    return normalized.length > 0 ? normalized : null;
  }

  function normalizeDefinitionItem(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const meaning = normalizeOptionalString(value.meaning);
    if (!meaning) {
      return null;
    }

    const normalized = {
      meaning
    };

    const pos = normalizeOptionalString(value.pos);
    if (pos) {
      normalized.pos = pos;
    }

    if (value.example !== undefined) {
      const example = normalizeDefinitionExample(value.example);
      if (!example) {
        return null;
      }
      normalized.example = example;
    }

    return normalized;
  }

  function normalizeDefinitionExample(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const source = normalizeOptionalString(value.source);
    const target = normalizeOptionalString(value.target);
    if (!source || !target) {
      return null;
    }

    return {
      source,
      target
    };
  }

  function normalizeOptionalString(value) {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    return normalized || null;
  }

  function isSingleWordInput(text) {
    const normalized = String(text || '').trim();
    if (!normalized) {
      return false;
    }

    return /^[\p{L}]+(?:['’\-][\p{L}]+)*$/u.test(normalized);
  }

  function summarizeLexicalDetails(lexicalDetails) {
    if (!lexicalDetails) {
      return {
        phonetic: false,
        definitions: 0,
        contextualAnalysis: false
      };
    }

    return {
      phonetic: Boolean(lexicalDetails.phonetic),
      definitions: Array.isArray(lexicalDetails.definitions) ? lexicalDetails.definitions.length : 0,
      contextualAnalysis: Boolean(lexicalDetails.contextual_analysis)
    };
  }

  function ensureCard() {
    if (state.cardEl) {
      return state.cardEl;
    }

    const card = document.createElement('div');
    card.className = 'stt-card stt-card--status';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Reading assistant');
    card.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });

    state.uiRoot.appendChild(card);
    state.cardEl = card;
    ensureCardResizeHandle();
    applyCardWidth();
    return card;
  }

  function ensureCardResizeHandle() {
    if (!state.cardEl) {
      return;
    }

    if (state.cardEl.querySelector('.stt-card-resize-handle')) {
      return;
    }

    const handle = document.createElement('div');
    handle.className = 'stt-card-resize-handle';
    handle.setAttribute('aria-hidden', 'true');
    handle.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    handle.addEventListener('pointerdown', onCardResizePointerDown);
    state.cardEl.appendChild(handle);
  }

  function onCardResizePointerDown(event) {
    if (!state.cardEl || !state.activeSelection) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    state.cardResizeSession = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: Math.max(state.cardEl.offsetWidth, MIN_CARD_WIDTH_PX)
    };

    window.addEventListener('pointermove', onCardResizePointerMove, true);
    window.addEventListener('pointerup', onCardResizePointerEnd, true);
    window.addEventListener('pointercancel', onCardResizePointerEnd, true);
    document.documentElement.classList.add('stt-card-resizing');
    state.cardEl.classList.add('stt-resizing');
  }

  function onCardResizePointerMove(event) {
    if (!state.cardResizeSession || event.pointerId !== state.cardResizeSession.pointerId) {
      return;
    }

    event.preventDefault();

    const deltaX = event.clientX - state.cardResizeSession.startX;
    state.cardWidthPx = clampCardWidth(state.cardResizeSession.startWidth + deltaX);

    if (state.activeSelection && state.cardEl) {
      positionCard(state.activeSelection.rect);
    }
  }

  function onCardResizePointerEnd(event) {
    if (!state.cardResizeSession || event.pointerId !== state.cardResizeSession.pointerId) {
      return;
    }

    stopCardResize();

    const persistedWidth = clamp(
      Math.round(state.cardWidthPx),
      MIN_CARD_WIDTH_PX,
      MAX_CARD_WIDTH_PX
    );
    state.cardWidthPx = persistedWidth;
    queuePersistCardWidth(persistedWidth);

    if (state.activeSelection && state.cardEl) {
      positionCard(state.activeSelection.rect);
    }
  }

  function stopCardResize() {
    if (!state.cardResizeSession) {
      return;
    }

    state.cardResizeSession = null;
    window.removeEventListener('pointermove', onCardResizePointerMove, true);
    window.removeEventListener('pointerup', onCardResizePointerEnd, true);
    window.removeEventListener('pointercancel', onCardResizePointerEnd, true);
    document.documentElement.classList.remove('stt-card-resizing');
    state.cardEl?.classList.remove('stt-resizing');
  }

  function positionCard(selectionRect) {
    if (!state.cardEl) {
      return;
    }

    applyCardWidth();

    const cardWidth = Math.max(state.cardEl.offsetWidth, 1);
    const measuredHeight = Math.max(state.cardEl.offsetHeight, MIN_CARD_HEIGHT_PX);
    const cardHeight = measuredHeight;

    const candidates = [
      {
        left: selectionRect.right + PLACEMENT_GAP_PX,
        top: selectionRect.top
      },
      {
        left: selectionRect.right + PLACEMENT_GAP_PX,
        top: selectionRect.bottom + PLACEMENT_GAP_PX
      },
      {
        left: selectionRect.left,
        top: selectionRect.bottom + PLACEMENT_GAP_PX
      },
      {
        left: selectionRect.left - cardWidth - PLACEMENT_GAP_PX,
        top: selectionRect.top
      }
    ];

    const scored = candidates.map((candidate) => {
      const positioned = clampCardPosition(candidate.left, candidate.top, cardWidth, cardHeight);
      const cardRect = {
        left: positioned.left,
        top: positioned.top,
        right: positioned.left + cardWidth,
        bottom: positioned.top + cardHeight
      };
      return {
        ...positioned,
        overlap: overlapArea(cardRect, selectionRect)
      };
    });

    const nonOverlapping = scored.find((entry) => entry.overlap === 0);
    const best =
      nonOverlapping ||
      scored.reduce((lowest, current) =>
        current.overlap < lowest.overlap ? current : lowest
      );

    state.cardEl.style.left = `${best.left}px`;
    state.cardEl.style.top = `${best.top}px`;
  }

  function clampCardPosition(left, top, width, height) {
    const maxLeft = Math.max(VIEWPORT_MARGIN_PX, window.innerWidth - width - VIEWPORT_MARGIN_PX);
    const maxTop = Math.max(VIEWPORT_MARGIN_PX, window.innerHeight - height - VIEWPORT_MARGIN_PX);

    return {
      left: clamp(left, VIEWPORT_MARGIN_PX, maxLeft),
      top: clamp(top, VIEWPORT_MARGIN_PX, maxTop)
    };
  }

  function overlapArea(rectA, rectB) {
    const overlapWidth = Math.max(
      0,
      Math.min(rectA.right, rectB.right) - Math.max(rectA.left, rectB.left)
    );
    const overlapHeight = Math.max(
      0,
      Math.min(rectA.bottom, rectB.bottom) - Math.max(rectA.top, rectB.top)
    );

    return overlapWidth * overlapHeight;
  }

  function handleDocumentMouseDown(event) {
    if (!state.cardEl) {
      return;
    }

    const target = event.composedPath()[0];
    if (!(target instanceof Node)) {
      return;
    }

    if (state.cardEl.contains(target)) {
      return;
    }

    if (state.triggerEl && state.triggerEl.contains(target)) {
      return;
    }

    removeCard();
  }

  function clearActiveSelection(reason) {
    if (!state.activeSelection && !state.triggerEl && !state.cardEl) {
      return;
    }

    clearHoverTimer();
    cancelActiveRequest();
    state.activeSelection = null;

    if (state.triggerEl) {
      state.triggerEl.remove();
      state.triggerEl = null;
    }

    removeCard();

    debugLog('selection_cleared', {
      reason
    });
  }

  function removeCard() {
    cancelActiveRequest();
    stopSpeech();
    if (!state.cardEl) {
      return;
    }
    stopCardResize();
    state.cardEl.remove();
    state.cardEl = null;
  }

  function clearHoverTimer() {
    if (state.hoverTimerId === null) {
      return;
    }
    window.clearTimeout(state.hoverTimerId);
    state.hoverTimerId = null;
  }

  function buildSelectionFingerprint(text, rect, triggerRect) {
    return [
      text,
      rect.left.toFixed(1),
      rect.top.toFixed(1),
      rect.width.toFixed(1),
      rect.height.toFixed(1),
      triggerRect.left.toFixed(1),
      triggerRect.top.toFixed(1),
      triggerRect.width.toFixed(1),
      triggerRect.height.toFixed(1)
    ].join('|');
  }

  function cloneRect(rect) {
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height
    };
  }

  function createSelectedTextDiagnostics(text) {
    const normalized = String(text || '');
    return {
      length: normalized.length
    };
  }

  function makeSelectionId() {
    state.selectionCounter += 1;
    return `selection-${Date.now()}-${state.selectionCounter}`;
  }

  function makeRequestId() {
    state.requestCounter += 1;
    return `request-${Date.now()}-${state.requestCounter}`;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function applyCardWidth() {
    if (!state.cardEl) {
      return;
    }

    const width = getEffectiveCardWidth();
    state.cardEl.style.width = `${width}px`;
  }

  function getEffectiveCardWidth() {
    return clampCardWidth(state.cardWidthPx);
  }

  function clampCardWidth(value) {
    const rounded = Math.round(Number(value));
    if (!Number.isFinite(rounded)) {
      return DEFAULT_CARD_WIDTH_PX;
    }

    const viewportMax = Math.max(120, window.innerWidth - VIEWPORT_MARGIN_PX * 2);
    const minWidth = Math.min(MIN_CARD_WIDTH_PX, viewportMax);
    const maxWidth = Math.max(minWidth, Math.min(MAX_CARD_WIDTH_PX, viewportMax));
    return clamp(rounded, minWidth, maxWidth);
  }

  function normalizePersistedCardWidth(value) {
    const rounded = Math.round(Number(value));
    if (!Number.isFinite(rounded)) {
      return null;
    }
    return clamp(rounded, MIN_CARD_WIDTH_PX, MAX_CARD_WIDTH_PX);
  }

  function queuePersistCardWidth(widthPx) {
    state.cardWidthPersistQueue = state.cardWidthPersistQueue
      .then(async () => {
        await chrome.storage.sync.set({
          [CARD_WIDTH_STORAGE_KEY]: widthPx
        });
      })
      .catch(() => {});
  }

  function ensureStyles() {
    const hostEl = document.createElement('div')
    hostEl.id = 'selected-reading-assistant'
    state.uiRoot = hostEl.attachShadow({ mode: 'open' })
    const styleEl = document.createElement('style')
    styleEl.textContent = `
      :host { all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
      *, *::before, *::after { box-sizing: border-box; }
      button { font: inherit; cursor: pointer; border: 0; }
      button:disabled { cursor: wait; opacity: .45; }
      button:focus-visible, summary:focus-visible { outline: 2px solid #68a287; outline-offset: 3px; }
      .stt-trigger { position: fixed; pointer-events: auto; display: grid; place-items: center;
        width: 28px; height: 28px; border-radius: 9px 9px 9px 2px; background: #1d6b53; color: #f6f3da;
        font: 16px Georgia, serif; box-shadow: 0 3px 12px #143e3429; padding: 0; }
      .stt-trigger:hover { background: #15573f; transform: translateY(-1px); }
      .stt-card { position: fixed; pointer-events: auto; width: ${DEFAULT_CARD_WIDTH_PX}px;
        min-height: ${MIN_CARD_HEIGHT_PX}px; max-height: calc(100vh - ${VIEWPORT_MARGIN_PX * 2}px);
        border: 1px solid #dde5dc; border-radius: 16px; background: #fffefa; color: #263b30;
        box-shadow: 0 12px 44px #1a342324, 0 2px 8px #1a342310;
        font: 14px/1.65 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif;
        text-align: left; letter-spacing: normal; white-space: pre-wrap; word-break: break-word;
        box-sizing: border-box; overflow-y: auto; overflow-x: hidden; scrollbar-width: thin;
        scrollbar-color: #ccd7cc transparent; }
      .stt-toolbar { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px 0;
        white-space: normal; }
      .stt-tabs { display: flex; gap: 3px; padding: 3px; background: #edf1e9; border-radius: 9px; }
      .stt-tab { padding: 5px 12px; background: transparent; color: #788375; border-radius: 7px; font-size: 12px; }
      .stt-tab[aria-pressed=true] { background: #fffefa; color: #1d6b53; box-shadow: 0 1px 4px #263b3010; font-weight: 600; }
      .stt-close { background: transparent; color: #8a9387; font-size: 23px; padding: 0 3px; line-height: 1; }
      .stt-card-block { padding: 14px 18px; }
      .stt-card-block--source { border-bottom: 1px solid #e6ebe1; }
      .stt-source-text { font: 22px/1.4 Georgia, 'Times New Roman', serif; color: #253c2d; max-height: 140px; overflow-y: auto; }
      .stt-source-text--passage { font-size: 16px; }
      .stt-sound-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 10px; white-space: normal; }
      .stt-speak { padding: 4px 9px; border-radius: 6px; color: #1d6b53; background: #eaf1e7; font-size: 11px; }
      .stt-phonetic { font: 13px/1.4 'Segoe UI', sans-serif; color: #7b8678; }
      .stt-speech-status { color: #a46738; font-size: 11px; margin-top: 4px; }
      .stt-speech-status:empty { display: none; }
      .stt-section-label { color: #8b9684; font-size: 9px; letter-spacing: 1.6px; line-height: 1.5;
        padding: 15px 18px 0; font-weight: 600; white-space: normal; }
      .stt-card-block--translation { padding-top: 8px; color: #384b3c; }
      .stt-guide-heading { display: flex; align-items: baseline; justify-content: space-between; padding-right: 18px; }
      .stt-progress { color: #8a9881; font-size: 10px; }
      .stt-hints { padding: 4px 18px 0; }
      .stt-hint { display: flex; gap: 10px; align-items: flex-start; padding-top: 12px; }
      .stt-hint-number { flex: 0 0 20px; height: 20px; display: grid; place-items: center; background: #eef2e5;
        border-radius: 50%; color: #648257; font-size: 10px; margin-top: 2px; }
      .stt-hint p { margin: 0; font-size: 13px; }
      .stt-actions { display: flex; align-items: center; gap: 16px; padding: 16px 18px; white-space: normal; }
      .stt-button { border-radius: 8px; padding: 8px 12px; background: #1d6b53; color: #fff; font-size: 12px; }
      .stt-button:hover { background: #15573f; }
      .stt-text-button { padding: 0; background: transparent; color: #63816b; font-size: 11px; }
      .stt-text-button:hover { color: #1d6b53; text-decoration: underline; }
      .stt-answer { background: #f1f5ec; padding: 0 18px 16px; outline: none; border-top: 1px solid #e4ebdb; }
      .stt-answer .stt-section-label { padding-left: 0; padding-right: 0; }
      .stt-answer p { margin: 8px 0 0; font-size: 13px; }
      .stt-meaning { font-weight: 600; }
      .stt-explanation { color: #65735e; }
      .stt-usage { color: #4a7455; font-size: 12px; border-left: 2px solid #a3bea0; padding-left: 10px; }
      .stt-example { font-family: Georgia, serif; font-style: italic; }
      .stt-context { border-top: 1px solid #e8ede2; padding: 10px 18px; color: #86907d; font-size: 11px; }
      .stt-context summary { cursor: pointer; }
      .stt-context p { max-height: 150px; overflow: auto; margin: 8px 0 0; }
      .stt-vocabulary-actions { border-top: 1px solid #e8ede2; padding-top: 10px; padding-bottom: 10px; }
      .stt-save:disabled { cursor: default; opacity: .7; }
      .stt-save-status { color: #94613c; padding: 0 18px 10px; font-size: 11px; }
      .stt-error { color: #94613c; font-size: 12px; padding-bottom: 0; }
      .stt-loading { color: #87927d; font-size: 12px; }
      .stt-card-block--lexical { border-top: 1px solid #e6ebe1; background: #f8faf4; font-size: 12px; }
      .stt-lexical-row { display: flex; align-items: flex-start; gap: 6px; margin-top: 7px; }
      .stt-lexical-row:first-child { margin-top: 0; }
      .stt-lexical-label { font-weight: 600; color: #748369; }
      .stt-lexical-value { flex: 1; }
      .stt-lexical-row--definitions { display: block; }
      .stt-definition-list { margin: 5px 0 0; padding-left: 18px; }
      .stt-definition-item { margin-top: 5px; }
      .stt-card-resize-handle { position: absolute; top: 45px; right: 0; width: 8px; height: calc(100% - 45px);
        cursor: ew-resize; touch-action: none; }
      .stt-card-resize-handle:hover { background: #1d6b530b; }
      .stt-card.stt-resizing, .stt-card.stt-resizing * { cursor: ew-resize !important; user-select: none !important; }
    `
    state.uiRoot.appendChild(styleEl)
    document.documentElement.appendChild(hostEl)
  }

  async function initReadingMode() {
    let values = {}
    const updateLearningModel = () => {
      const model = String(values.learning_model || values.model || 'qwen-mt-flash').toLowerCase()
      state.canFetchPhonetic = Boolean(model && !model.includes('qwen-mt'))
    }
    try {
      values = await chrome.storage.sync.get(['reading_mode', 'learning_model', 'model'])
      state.defaultMode = values?.reading_mode === 'guide' ? 'guide' : 'translate'
      state.mode = state.defaultMode
      updateLearningModel()
    } catch { }
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'sync') return
      for (const key of ['model', 'learning_model']) {
        if (key in changes) values[key] = changes[key].newValue
      }
      updateLearningModel()
      if (!('reading_mode' in changes)) return
      const mode = changes.reading_mode.newValue === 'guide' ? 'guide' : 'translate'
      state.defaultMode = mode
      if (!state.cardEl) state.mode = mode
    })
  }

  function getSelectionContext(range) {
    const empty = { context: '', contextStart: null, contextEnd: null }
    try {
      const ancestorEl = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement
      const containerEl = ancestorEl?.closest('p, li, blockquote, td, article, section, div')
      if (!containerEl || containerEl.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) return empty
      const preceding = range.cloneRange()
      preceding.selectNodeContents(containerEl)
      preceding.setEnd(range.startContainer, range.startOffset)
      const rawSelection = range.toString()
      const offset = preceding.toString().length + (rawSelection.match(/^\s*/u)?.[0].length || 0)
      const text = containerEl.textContent || ''
      const selectedText = rawSelection.trim()
      const start = Math.max(0, offset - 600)
      const rawContext = text.slice(start, Math.min(text.length, offset + Math.min(selectedText.length, 1200) + 600))
      const trimmedLeading = rawContext.length - rawContext.trimStart().length
      const context = rawContext.trim().slice(0, 2400)
      const contextStart = offset - start - trimmedLeading
      const contextEnd = contextStart + selectedText.length
      const hasExactSpan = contextStart >= 0 && context.slice(contextStart, contextEnd) === selectedText
      return { context, contextStart: hasExactSpan ? contextStart : null, contextEnd: hasExactSpan ? contextEnd : null }
    } catch {
      return empty
    }
  }

  function scheduleViewportUpdate(event) {
    if (!state.activeSelection || event?.composedPath().includes(state.cardEl) || state.viewportFrame) return
    state.viewportFrame = window.requestAnimationFrame(() => {
      state.viewportFrame = null
      const selection = state.activeSelection
      if (!selection) return
      const rect = selection.range.getBoundingClientRect()
      if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) {
        clearActiveSelection('selection_outside_viewport')
        return
      }
      selection.rect = cloneRect(rect)
      selection.triggerRect = getTriggerAnchorRect(selection.range, rect)
      selection.fingerprint = buildSelectionFingerprint(selection.text, rect, selection.triggerRect)
      positionTrigger(selection.triggerRect)
      if (state.cardEl) positionCard(selection.rect)
    })
  }

  async function initCardWidthSetting() {
    try {
      const saved = await chrome.storage.sync.get([CARD_WIDTH_STORAGE_KEY]);
      const normalized = normalizePersistedCardWidth(saved?.[CARD_WIDTH_STORAGE_KEY]);
      if (normalized !== null) {
        state.cardWidthPx = normalized;
      }
    } catch {}

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'sync') {
        return;
      }

      if (!changes || !(CARD_WIDTH_STORAGE_KEY in changes)) {
        return;
      }

      const nextValue = changes[CARD_WIDTH_STORAGE_KEY]?.newValue;
      const normalized = normalizePersistedCardWidth(nextValue);
      state.cardWidthPx = normalized === null ? DEFAULT_CARD_WIDTH_PX : normalized;

      if (state.activeSelection && state.cardEl) {
        positionCard(state.activeSelection.rect);
      }
    });

    if (state.activeSelection && state.cardEl) {
      positionCard(state.activeSelection.rect);
    }
  }

  async function initDebugLoggingSetting() {
    try {
      const saved = await chrome.storage.sync.get([DEBUG_LOGGING_KEY]);
      const enabled = saved?.[DEBUG_LOGGING_KEY];
      if (typeof enabled === 'boolean') {
        debugLoggingEnabled = enabled;
      }
    } catch {
      debugLoggingEnabled = false;
    }

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'sync') {
        return;
      }

      const next = changes?.[DEBUG_LOGGING_KEY]?.newValue;
      if (typeof next === 'boolean') {
        debugLoggingEnabled = next;
      }
    });
  }

  function matchesUrlPattern(url, pattern) {
    if (pattern.startsWith('=')) return url === pattern.slice(1)
    try {
      const current = new URL(url)
      const rule = new URL(pattern)
      if (current.origin !== rule.origin) return false
      if (rule.search && current.search !== rule.search) return false
      if (rule.hash && current.hash !== rule.hash) return false
      const path = rule.pathname.replace(/\/$/, '')
      return current.pathname === path || current.pathname.startsWith(`${path}/`)
    } catch {
      return false
    }
  }

  function isUrlBlacklisted() {
    if (urlBlacklist.length === 0) {
      return false;
    }

    const currentUrl = window.location.href;
    return urlBlacklist.some((pattern) => matchesUrlPattern(currentUrl, pattern));
  }

  async function initUrlBlacklistSetting() {
    try {
      const saved = await chrome.storage.sync.get([DISABLED_URL_PATTERNS_KEY]);
      const patterns = saved?.[DISABLED_URL_PATTERNS_KEY];
      if (Array.isArray(patterns)) {
        urlBlacklist = patterns.filter((p) => typeof p === 'string' && p.length > 0);
      }
    } catch {}

    if (isUrlBlacklisted()) clearActiveSelection('url_blacklisted');

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'sync') {
        return;
      }

      if (!changes || !(DISABLED_URL_PATTERNS_KEY in changes)) {
        return;
      }

      const nextPatterns = changes[DISABLED_URL_PATTERNS_KEY]?.newValue;
      if (Array.isArray(nextPatterns)) {
        urlBlacklist = nextPatterns.filter((p) => typeof p === 'string' && p.length > 0);
      } else {
        urlBlacklist = [];
      }

      if (isUrlBlacklisted()) {
        clearActiveSelection('url_blacklisted');
      }
    });
  }

  function debugLog(event, fields) {
    if (!debugLoggingEnabled) {
      return;
    }

    console.debug(
      LOG_PREFIX,
      JSON.stringify({
        level: 'debug',
        event,
        timestamp: new Date().toISOString(),
        ...fields
      })
    );
  }
})();
