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
  const DEFAULT_CARD_WIDTH_PX = 300;
  const MIN_CARD_WIDTH_PX = 220;
  const MAX_CARD_WIDTH_PX = 720;
  const MIN_CARD_HEIGHT_PX = 110;
  const CARD_WIDTH_STORAGE_KEY = 'translation_card_width_px';
  const TRIGGER_SIZE_PX = 16;
  const VIEWPORT_MARGIN_PX = 8;
  const LOG_PREFIX = '[selected-text-translation]';
  const DEBUG_LOGGING_KEY = 'debug_logging_enabled';
  const DISABLED_URL_PATTERNS_KEY = 'disabled_url_patterns';
  let debugLoggingEnabled = false;
  let urlBlacklist = [];

  const state = {
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
  bindListeners();

  function bindListeners() {
    document.addEventListener('selectionchange', scheduleSelectionScan, true);
    document.addEventListener('mousedown', handleDocumentMouseDown, true);

    chrome.runtime.onMessage.addListener((message) => {
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
    state.activeSelection = {
      id: selectionId,
      text,
      rect: cloneRect(rect),
      triggerRect: cloneRect(triggerRect),
      fingerprint
    };

    state.activeRequest = null;
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

    const trigger = document.createElement('div');
    trigger.className = 'stt-trigger';
    trigger.setAttribute('aria-hidden', 'true');

    trigger.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    trigger.addEventListener('mouseenter', onTriggerHoverStart);
    trigger.addEventListener('mouseleave', onTriggerHoverEnd);
    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
    });

    document.documentElement.appendChild(trigger);
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

  function startTranslationRequest() {
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

    const requestId = makeRequestId();
    const selectionId = state.activeSelection.id;

    state.activeRequest = {
      selectionId,
      requestId,
      inFlight: true
    };

    renderLoadingCard('Translating...');

    debugLog('request_start', {
      selectionId,
      requestId,
      selectedText: createSelectedTextDiagnostics(state.activeSelection.text)
    });

    chrome.runtime.sendMessage({
      type: TRANSLATION_MESSAGE_TYPES.START_TRANSLATION,
      payload: {
        selectionId,
        requestId,
        text: state.activeSelection.text
      }
    });
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

    if (status === TRANSLATION_EVENT_STATUS.STARTED) {
      renderLoadingCard('Translating...');
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
      const translatedText = String(payload.translatedText || '').trim();
      if (translatedText) {
        const lexicalDetails = normalizeLexicalDetails(payload.lexicalDetails);
        renderSuccessCard(state.activeSelection.text, translatedText, lexicalDetails);
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
      renderStatusCard('Configuration required. Open extension options.');
      debugLog('missing_configuration', {
        selectionId,
        requestId
      });
      return;
    }

    if (status === TRANSLATION_EVENT_STATUS.ERROR) {
      const message = String(payload.message || 'Translation failed.').trim();
      renderStatusCard(message || 'Translation failed.');
      debugLog('request_error', {
        selectionId,
        requestId,
        message
      });
    }
  }

  function renderLoadingCard(message) {
    const card = ensureCard();
    card.classList.remove('stt-card--result');
    card.classList.add('stt-card--status');
    card.textContent = message;
    ensureCardResizeHandle();
    positionCard(state.activeSelection.rect);
  }

  function renderStatusCard(message) {
    const card = ensureCard();
    card.classList.remove('stt-card--result');
    card.classList.add('stt-card--status');
    card.textContent = message;
    ensureCardResizeHandle();
    positionCard(state.activeSelection.rect);
  }

  function renderSuccessCard(sourceText, translatedText, lexicalDetails) {
    const card = ensureCard();
    card.classList.remove('stt-card--status');
    card.classList.add('stt-card--result');

    card.innerHTML = '';

    const sourceBlock = document.createElement('div');
    sourceBlock.className = 'stt-card-block stt-card-block--source';
    sourceBlock.textContent = sourceText;

    const translationBlock = document.createElement('div');
    translationBlock.className = 'stt-card-block stt-card-block--translation';
    translationBlock.textContent = translatedText;

    card.append(sourceBlock, translationBlock);

    const lexicalBlock = buildLexicalBlock(sourceText, lexicalDetails);
    if (lexicalBlock) {
      card.append(lexicalBlock);
    }

    ensureCardResizeHandle();
    positionCard(state.activeSelection.rect);
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

    if (normalized.phonetic) {
      lexicalBlock.append(createLexicalRow('Phonetic', normalized.phonetic));
      hasContent = true;
    }

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

    const tokens = normalized.split(/\s+/u).filter(Boolean);
    return tokens.length === 1;
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
    card.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });

    document.documentElement.appendChild(card);
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

    const target = event.target;
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
    state.activeSelection = null;
    state.activeRequest = null;

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
      length: normalized.length,
      preview: normalized.slice(0, 36)
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
    if (document.getElementById('stt-style')) {
      return;
    }

    const style = document.createElement('style');
    style.id = 'stt-style';
    style.textContent = `
      .stt-trigger {
        position: fixed;
        width: ${TRIGGER_SIZE_PX}px;
        height: ${TRIGGER_SIZE_PX}px;
        border-radius: 9999px;
        background: #19b84a;
        border: 2px solid #121212;
        box-shadow: 2px 2px 0 #121212;
        z-index: 2147483646;
        cursor: pointer;
      }

      .stt-card {
        position: fixed;
        width: ${DEFAULT_CARD_WIDTH_PX}px;
        min-height: ${MIN_CARD_HEIGHT_PX}px;
        max-height: calc(100vh - ${VIEWPORT_MARGIN_PX * 2}px);
        background: #ffffff;
        border: 2px solid #121212;
        box-shadow: 5px 5px 0 #121212;
        z-index: 2147483647;
        color: #111111;
        font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
        font-size: 14px;
        line-height: 1.45;
        white-space: pre-wrap;
        word-break: break-word;
        box-sizing: border-box;
        overflow-y: auto;
        overflow-x: hidden;
        padding-right: 10px;
      }

      .stt-card--status {
        min-height: auto;
        padding: 10px 12px;
      }

      .stt-card--result {
        padding: 0;
      }

      .stt-card-block {
        padding: 10px 12px;
      }

      .stt-card-block--source {
        border-bottom: 2px solid #121212;
      }

      .stt-card-block--translation {
        background: #f7f7f7;
      }

      .stt-card-block--lexical {
        border-top: 1px solid #d4d4d4;
        background: #fcfcfc;
      }

      .stt-lexical-row {
        display: flex;
        align-items: flex-start;
        gap: 6px;
        margin-top: 6px;
      }

      .stt-lexical-row:first-child {
        margin-top: 0;
      }

      .stt-lexical-label {
        flex: 0 0 auto;
        font-weight: 600;
      }

      .stt-lexical-value {
        flex: 1 1 auto;
      }

      .stt-lexical-row--definitions {
        display: block;
      }

      .stt-definition-list {
        margin: 4px 0 0;
        padding-left: 18px;
      }

      .stt-definition-item {
        margin: 2px 0;
      }

      .stt-card-resize-handle {
        position: absolute;
        top: 0;
        right: 0;
        width: 12px;
        height: 100%;
        cursor: ew-resize;
        background: linear-gradient(
          to right,
          rgba(0, 0, 0, 0),
          rgba(17, 17, 17, 0.08)
        );
      }

      .stt-card-resizing {
        cursor: ew-resize !important;
        user-select: none !important;
      }
    `;

    document.documentElement.appendChild(style);
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
      debugLoggingEnabled = true;
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

  function isUrlBlacklisted() {
    if (urlBlacklist.length === 0) {
      return false;
    }

    const currentUrl = window.location.href;
    return urlBlacklist.some((pattern) => currentUrl.startsWith(pattern));
  }

  async function initUrlBlacklistSetting() {
    try {
      const saved = await chrome.storage.sync.get([DISABLED_URL_PATTERNS_KEY]);
      const patterns = saved?.[DISABLED_URL_PATTERNS_KEY];
      if (Array.isArray(patterns)) {
        urlBlacklist = patterns.filter((p) => typeof p === 'string' && p.length > 0);
      }
    } catch {}

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
