import { createResultCache, createResultCacheKey } from './result-cache.js'
import { getContextSentence } from './context-sentence.js'
import { createQwenTranslationScope, extractQwenScopedTranslation } from './qwen-context.js'
import { handleVocabularyMessage } from './vocabulary-messages.js'
import { handleProviderDiagnostics } from './provider-diagnostics.js'
import {
  ENGLISH_EXPLANATION_TARGET,
  STORAGE_KEYS,
  TRANSLATION_MESSAGE_TYPES,
  TRANSLATION_EVENT_STATUS,
  buildGenericRequest,
  buildQwenMtRequest,
  createSelectedTextDiagnostics,
  extractDeltaContent,
  extractGenericResponse,
  isSingleWordInput,
  readStructuredPreview,
  usesStructuredOutputForModel,
} from './translation-contracts.js'
import { readProviderSettings } from './provider-settings.js'
import { buildReadingRequest, getLearningModel, parseReadingResponse, readReadingSettings,
  supportsTranslationStructure } from './reading-support.js'
import { handleSpeechMessage } from './speech.js'
import { makeMemoryKey, readMemoryEntry, writeMemoryEntry } from './translation-memory.js'
import { isRateLimited, planRetry, sleepAbortable } from './retry-policy.js'

const LOG_PREFIX = '[selected-text-translation]'
const activeRequests = new Map()
const resultCache = createResultCache()
const MEMORY_STORAGE_KEY = 'translation_memory'
const IS_EXTENSION_SERVICE_WORKER = typeof ServiceWorkerGlobalScope !== 'undefined'
let translationMemoryPromise = null

async function loadTranslationMemory() {
  if (!translationMemoryPromise) {
    translationMemoryPromise = (async () => {
      try {
        const area = chrome?.storage?.local
        const values = area ? await area.get(MEMORY_STORAGE_KEY) : null
        const stored = values?.[MEMORY_STORAGE_KEY]
        return stored && typeof stored === 'object' ? stored : {}
      } catch {
        return {}
      }
    })()
  }
  return translationMemoryPromise
}

async function rememberTranslation(memory, key, result) {
  const next = writeMemoryEntry(memory, key, result)
  translationMemoryPromise = Promise.resolve(next)
  try {
    const area = chrome?.storage?.local
    if (area) await area.set({ [MEMORY_STORAGE_KEY]: next })
  } catch { }
  return next
}
const inflightCacheStates = new Map()
let cacheEpoch = 0
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync' || !['base_url', 'api_key', 'model', 'learning_model'].some((key) => key in changes)) return
  cacheEpoch += 1
  resultCache.clear()
})
let debugLoggingEnabled = false

function isDesktopReadingAnalysis(payload) {
  return !IS_EXTENSION_SERVICE_WORKER && payload?.requestScope === 'reading'
    && ['structure', 'article-explanation'].includes(payload.kind)
}

void initDebugLoggingSetting()
chrome.commands?.onCommand.addListener((command) => {
  if (command !== 'open-reading-assistant') return
  void (async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (typeof tab?.id !== 'number') return
      chrome.tabs.sendMessage(tab.id, { type: 'OPEN_READING_ASSISTANT' }, () => { void chrome.runtime.lastError })
    } catch { }
  })()
})
chrome.runtime.onMessage.addListener(handleSpeechMessage)
chrome.runtime.onMessage.addListener(handleVocabularyMessage)
chrome.runtime.onMessage.addListener(handleProviderDiagnostics)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'OPEN_SETTINGS') {
    chrome.runtime.openOptionsPage(() => {
      const error = chrome.runtime.lastError
      sendResponse({ ok: !error })
    })
    return true
  }
  const tabId = sender?.tab?.id
  if (typeof tabId !== 'number') return false
  const frameId = sender.frameId || 0
  // Desktop article analysis runs independently of the selected-text result.
  // Keep it in its own fixed slot so retrying analysis cannot cancel a translation.
  const analysisScope = isDesktopReadingAnalysis(message?.payload)
  const key = `${tabId}:${frameId}${analysisScope ? ':analysis' : ''}`
  if (message?.type === 'CANCEL_TRANSLATION') {
    const active = activeRequests.get(key)
    if (active?.requestId === message.payload?.requestId) active.controller.abort()
    sendResponse({ accepted: true })
    return false
  }
  if (message?.type !== TRANSLATION_MESSAGE_TYPES.START_TRANSLATION) return false
  void handleStartTranslation({ tabId, frameId, key, payload: message.payload })
  sendResponse({ accepted: true })
  return false
})

function acquireCacheWrite(key, isForced) {
  let state = inflightCacheStates.get(key)
  if (!state) {
    state = { revision: 0, users: 0 }
    inflightCacheStates.set(key, state)
  }
  if (isForced) state.revision += 1
  state.users += 1
  return { key, state, revision: state.revision }
}

function releaseCacheWrite(lease) {
  if (!lease) return
  lease.state.users -= 1
  if (!lease.state.users && inflightCacheStates.get(lease.key) === lease.state) inflightCacheStates.delete(lease.key)
}

async function translateSentenceStructure({ settings, endpoint, text, signal }) {
  const reading = await readReadingSettings()
  const model = getLearningModel(settings.model, reading.learningModel)
  if (!model || signal.aborted) return { structure: [] }
  const fetchProvider = chrome.providerFetch?.('guidance') ?? fetch
  const response = await fetchProvider(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildReadingRequest({ model, text, kind: 'structure' })),
    signal,
  })
  if (!response.ok) return { structure: [] }
  const content = readNonStreamMessageContent((await response.json())?.choices?.[0])
  return parseReadingResponse(content, 'structure', { text, includeSentenceAnalysis: true })
}

async function handleStartTranslation({ tabId, frameId, key, payload }) {
  const selectionId = String(payload?.selectionId || '')
  const requestId = String(payload?.requestId || '')
  const text = String(payload?.text || '').trim()
  const kind = ['guide', 'pronunciation'].includes(payload?.kind)
    || isDesktopReadingAnalysis(payload)
    ? payload.kind : 'translate'
  const targetLanguage = payload?.targetLanguage
  const explainInEnglish = kind === 'translate' && targetLanguage === ENGLISH_EXPLANATION_TARGET
  const readingOptions = { text, sourceLanguage: payload?.sourceLanguage, targetLanguage,
    includeSentenceStructure: !IS_EXTENSION_SERVICE_WORKER && payload?.includeSentenceStructure !== false,
    includeSentenceAnalysis: kind === 'structure', requireStructure: kind === 'structure' }
  const contextSentence = getContextSentence({ text, context: payload?.context,
    contextStart: payload?.contextStart, contextEnd: payload?.contextEnd })
  const controller = new AbortController()
  const startedAt = Date.now()
  const requestEpoch = cacheEpoch
  let cacheKey = null
  let cacheLease = null
  activeRequests.get(key)?.controller.abort()
  const active = { requestId, controller }
  activeRequests.set(key, active)
  const timeoutId = setTimeout(() => controller.abort(new Error('timeout')), 25000)
  const isActive = () => activeRequests.get(key) === active && !controller.signal.aborted
  const emit = (event, shouldCache = true) => {
    if (isActive()) {
      if (shouldCache && cacheLease && cacheLease.state.revision === cacheLease.revision
        && requestEpoch === cacheEpoch && event.status === TRANSLATION_EVENT_STATUS.SUCCESS) {
        resultCache.set(cacheKey, event)
      }
      emitEvent(tabId, { selectionId, requestId, contextSentence, ...event }, frameId)
    }
  }

  try {
    if (!selectionId || !requestId || !text || text.length > 12000) {
      throw new Error('Select between 1 and 12,000 characters to continue.')
    }
    const settings = await readProviderSettings()
    if (!settings.baseUrl || !settings.apiKey || !settings.model) {
      emit({ status: TRANSLATION_EVENT_STATUS.MISSING_CONFIGURATION,
        message: 'Add your API key in extension settings to get started.' })
      return
    }
    let model = settings.model
    if (kind !== 'translate' || explainInEnglish) {
      const reading = await readReadingSettings()
      model = getLearningModel(settings.model, reading.learningModel)
      if (!model) {
        const message = explainInEnglish ? 'Choose a general-purpose learning model in Settings to explain text in English.'
          : kind === 'article-explanation' ? 'Choose a general-purpose learning model in Settings to explain sentences.'
            : 'Add a general-purpose learning model in settings for hints and phonetics. You can still listen.'
        emit({ status: TRANSLATION_EVENT_STATUS.MISSING_CONFIGURATION, kind, targetLanguage, message })
        return
      }
    }
    if (controller.signal.aborted) return
    let isQwenMtRequest = kind === 'translate' && !usesStructuredOutputForModel(model)
    const isDesktopWordTranslation = !IS_EXTENSION_SERVICE_WORKER && kind === 'translate' && isSingleWordInput(text)
    if (isDesktopWordTranslation && isQwenMtRequest) {
      const reading = await readReadingSettings()
      const enrichmentModel = getLearningModel('', reading.learningModel)
      if (enrichmentModel) {
        model = enrichmentModel
        isQwenMtRequest = false
        debugLog('single_word_lexical_enrichment', { selectionId, requestId, model })
      }
    }
    const useMemory = kind === 'translate' && IS_EXTENSION_SERVICE_WORKER
    const memoryKey = useMemory
      ? `${makeMemoryKey({ text, mode: kind, targetLanguage: targetLanguage || 'auto', sourceLanguage: payload?.sourceLanguage || 'auto', model, glossary: payload?.glossary })}`
        + `\u0000${String(payload?.context || '').slice(0, 2400)}`
        + `\u0000${payload?.contextStart ?? ''}\u0000${payload?.contextEnd ?? ''}`
      : null
    const memory = useMemory ? await loadTranslationMemory() : null
    const remembered = useMemory && payload?.forceRefresh !== true ? readMemoryEntry(memory, memoryKey) : null
    if (remembered && controller.signal.aborted === false) {
      emit({ status: TRANSLATION_EVENT_STATUS.SUCCESS, sourceText: text,
        translatedText: remembered.translatedText, lexicalDetails: remembered.lexical, fromMemory: true }, false)
      debugLog('translation_memory_hit', { selectionId, requestId, kind })
      return
    }
    const qwenScope = isQwenMtRequest ? createQwenTranslationScope({ text, context: payload?.context,
      contextStart: payload?.contextStart, contextEnd: payload?.contextEnd }) : null
    const endpoint = normalizeEndpoint(settings.baseUrl)
    const streamStructured = !IS_EXTENSION_SERVICE_WORKER
      && (kind === 'guide' || (isDesktopWordTranslation && !isQwenMtRequest))
      && supportsDashScopeStructuredStream(endpoint, model)
    const requestBody = kind !== 'translate'
      ? buildReadingRequest({ model, ...readingOptions, context: payload?.context,
          contextStart: payload?.contextStart, contextEnd: payload?.contextEnd, kind, stream: streamStructured })
      : isQwenMtRequest
        ? buildQwenMtRequest({ model, text, context: payload?.context,
            contextStart: payload?.contextStart, contextEnd: payload?.contextEnd, targetLanguage,
            sourceLanguage: payload?.sourceLanguage, glossary: payload?.glossary })
        : buildGenericRequest({ model, text, context: payload?.context,
            contextStart: payload?.contextStart, contextEnd: payload?.contextEnd, targetLanguage,
            sourceLanguage: payload?.sourceLanguage, glossary: payload?.glossary, stream: streamStructured,
            requireWordPronunciation: isDesktopWordTranslation && payload?.requestScope === 'reading' })
    try {
      cacheKey = await createResultCacheKey({ kind, endpoint, apiKey: settings.apiKey, requestBody,
        context: payload?.context, contextStart: payload?.contextStart, contextEnd: payload?.contextEnd })
    } catch { }
    if (controller.signal.aborted || activeRequests.get(key) !== active) return
    const canUseCache = Boolean(cacheKey && requestEpoch === cacheEpoch)
    const wantsStructure = !IS_EXTENSION_SERVICE_WORKER && payload?.includeSentenceStructure === true
      && kind === 'translate' && supportsTranslationStructure(text, payload?.sourceLanguage)
    const enrich = async (result) => {
      if (!wantsStructure || result.structure || !result.translatedText || !isActive()) return
      try {
        const analysis = await translateSentenceStructure({ settings, endpoint, text, signal: controller.signal })
        if (!isActive()) return
        if (analysis.structure.length || analysis.sentenceAnalysis) emit({ status: 'structure', ...analysis }, false)
        if (canUseCache && requestEpoch === cacheEpoch && cacheLease.state.revision === cacheLease.revision
          && resultCache.get(cacheKey)) {
          resultCache.set(cacheKey, { ...result, ...analysis })
        }
      } catch {
        // The translation is already complete. An optional analysis failure does not affect it.
      }
    }
    if (canUseCache) cacheLease = acquireCacheWrite(cacheKey, payload?.forceRefresh === true)
    if (canUseCache && payload?.forceRefresh === true) resultCache.delete(cacheKey)
    const cached = payload?.forceRefresh !== true && canUseCache && resultCache.get(cacheKey)
    if (cached) {
      emit(cached, false)
      debugLog('result_reused', { selectionId, requestId, kind, elapsedMs: Date.now() - startedAt })
      await enrich(cached)
      return
    }
    emit({ status: TRANSLATION_EVENT_STATUS.STARTED })
    debugLog('request_start', { selectionId, requestId, kind, model,
      selectedText: createSelectedTextDiagnostics(text) })
    debugLog('request_payload', { selectionId, requestId,
      request: { host: new URL(endpoint).host, body: sanitizeRequestBodyForLog(requestBody) } })
    const fetchProvider = chrome.providerFetch?.(kind === 'translate' ? 'translation' : 'guidance') ?? fetch
    let response
    let retryAttempt = 0
    while (true) {
      response = await fetchProvider(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      })
      if (!response.ok && isRateLimited(response.status)) {
        const decision = planRetry({ status: response.status, attempt: retryAttempt,
          retryAfter: response.headers?.get?.('retry-after') })
        if (decision.retry && !controller.signal.aborted && activeRequests.get(key) === active) {
          debugLog('rate_limit_retry', { selectionId, requestId, attempt: retryAttempt, delayMs: decision.delayMs })
          await sleepAbortable(decision.delayMs, controller.signal)
          retryAttempt += 1
          continue
        }
      }
      break
    }
    if (!response.ok) {
      const help = { 400: 'Check that the model supports this request format.', 401: 'Check your API key.', 403: 'Check model access.',
        404: 'Check the Base URL and model name.', 429: 'Rate limit reached. Please try again shortly.' }
      throw new Error(`Request failed (${response.status}). ${help[response.status] || 'Please try again.'}`)
    }
    let streamedContent
    if (streamStructured && response.headers.get('content-type')?.startsWith('text/event-stream')) {
      streamedContent = await consumeStructuredStream(response, kind, isActive, (preview) => {
        const result = kind === 'guide' ? { previewHint: preview } : { translatedText: preview }
        emit({ status: TRANSLATION_EVENT_STATUS.STREAM, kind, ...result })
        debugLog('structured_preview', { selectionId, requestId, kind, elapsedMs: Date.now() - startedAt })
      })
      if (!isActive()) return
    }
    if (kind !== 'translate') {
      const content = streamedContent ?? readNonStreamMessageContent((await response.json())?.choices?.[0])
      const result = parseReadingResponse(content, kind, { ...readingOptions, keepFirstHint: streamStructured })
      emit({ status: TRANSLATION_EVENT_STATUS.SUCCESS, kind, result })
      debugLog('request_success', { selectionId, requestId, kind, elapsedMs: Date.now() - startedAt })
      return
    }
    const translationResult = isQwenMtRequest
      ? requestBody.stream
        ? { translation: await consumeStream({ response, tabId, frameId, selectionId, requestId, scope: qwenScope,
            isActive }), lexicalDetails: null }
        : { translation: await consumeQwenMtNonStreamResponse({ response, selectionId, requestId, scope: qwenScope }),
            lexicalDetails: null }
      : parseGenericResult({
          content: streamedContent ?? await readGenericResponseContent({ response, selectionId, requestId }),
          selectionId, requestId, sourceText: text,
        })
    const result = { status: TRANSLATION_EVENT_STATUS.SUCCESS, sourceText: text,
      translatedText: translationResult.translation, lexicalDetails: translationResult.lexicalDetails }
    emit(result)
    if (useMemory) {
      await rememberTranslation(memory, memoryKey, {
        translatedText: translationResult.translation, lexical: translationResult.lexicalDetails,
      })
    }
    debugLog('request_success', { selectionId, requestId, elapsedMs: Date.now() - startedAt,
      translatedLength: translationResult.translation.length,
      lexicalFields: summarizeLexicalDetails(translationResult.lexicalDetails) })
    await enrich(result)
  } catch (error) {
    if (activeRequests.get(key) !== active) return
    if (controller.signal.aborted && controller.signal.reason?.message !== 'timeout') return
    const message = controller.signal.aborted ? 'The request timed out. Please try again.' : normalizeErrorMessage(error)
    debugLog('request_error', { selectionId, requestId, elapsedMs: Date.now() - startedAt })
    emitEvent(tabId, { status: TRANSLATION_EVENT_STATUS.ERROR, selectionId, requestId, message }, frameId)
  } finally {
    clearTimeout(timeoutId)
    releaseCacheWrite(cacheLease)
    if (activeRequests.get(key) === active) activeRequests.delete(key)
  }
}

async function* readStreamDeltas(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let remaining = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      const lines = (remaining + decoder.decode(value, { stream: !done })).split('\n')
      remaining = done ? '' : lines.pop()
      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') return
        let delta = ''
        try { delta = extractDeltaContent(JSON.parse(data)) } catch { }
        if (delta) yield delta
      }
      if (done) return
    }
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

async function consumeStructuredStream(response, kind, isActive, onPreview) {
  if (!response.body) throw new Error('The model did not return a stream body.')
  let content = ''
  let preview = ''
  for await (const delta of readStreamDeltas(response.body)) {
    if (!isActive()) break
    content += delta
    if (!preview) {
      preview = readStructuredPreview(content, kind)
      if (preview) onPreview(preview)
    }
  }
  return content
}

async function consumeStream({ response, tabId, frameId, selectionId, requestId, isActive, scope }) {
  if (!response.body) throw new Error('qwen-mt response did not include a stream body.')
  let qwenTranslation = ''
  let lastRenderedTranslation = ''
  for await (const delta of readStreamDeltas(response.body)) {
    if (!isActive()) break
    qwenTranslation += delta
    const partial = extractQwenScopedTranslation(qwenTranslation, scope, { partial: true })
    if (partial && partial !== lastRenderedTranslation) {
      lastRenderedTranslation = partial
      emitEvent(tabId, {
        status: TRANSLATION_EVENT_STATUS.STREAM,
        selectionId,
        requestId,
        translatedText: partial,
      }, frameId)
    }
    debugLog('stream_progress', {
      selectionId,
      requestId,
      chunkLength: delta.length,
      renderedLength: lastRenderedTranslation.length,
    })
  }

  const finalTranslation = extractQwenScopedTranslation(qwenTranslation, scope)

  if (!finalTranslation) {
    throw new Error('Unable to read translated text from stream response.');
  }

  return finalTranslation;
}

async function consumeQwenMtNonStreamResponse({ response, selectionId, requestId, scope }) {
  const rawResponseText = await safeReadText(response);
  if (!rawResponseText.trim()) {
    throw new Error('No translated text returned by endpoint.');
  }

  let json;
  try {
    json = JSON.parse(rawResponseText);
  } catch {
    debugLog('qwen_non_stream_parse_failed', {
      selectionId,
      requestId,
      stage: 'response_json',
      responseLength: rawResponseText.length
    });
    throw new Error('qwen-mt non-stream response is not valid JSON.');
  }

  const choice = Array.isArray(json?.choices) ? json.choices[0] : null;
  const content = readNonStreamMessageContent(choice);
  if (!content) {
    debugLog('qwen_non_stream_parse_failed', {
      selectionId,
      requestId,
      stage: 'message_content',
      responseLength: rawResponseText.length
    });
    throw new Error('qwen-mt non-stream response did not include translated content.');
  }

  return extractQwenScopedTranslation(content, scope)
}

async function readGenericResponseContent({ response, selectionId, requestId }) {
  const rawResponseText = await safeReadText(response);
  if (!rawResponseText.trim()) {
    throw new Error('No translated text returned by endpoint.');
  }

  let json;
  try {
    json = JSON.parse(rawResponseText);
  } catch {
    debugLog('generic_json_parse_failed', {
      selectionId,
      requestId,
      stage: 'response_json',
      expectedResponseFormat: 'json_object',
      possibleResponseFormatIncompatibility: true,
      responseLength: rawResponseText.length
    });
    throw new Error(
      'Generic-model response is not valid JSON. This endpoint may be incompatible with response_format=json_object.'
    );
  }

  const choice = Array.isArray(json?.choices) ? json.choices[0] : null;
  return readNonStreamMessageContent(choice)
}

function parseGenericResult({ content, selectionId, requestId, sourceText }) {
  if (!content) {
    throw new Error('No translated text returned by endpoint.');
  }

  const singleWordInput = isSingleWordInput(sourceText);
  const parsedContent = extractGenericResponse(content, {
    allowLexicalFields: singleWordInput
  });
  if (!parsedContent.translation) {
    debugLog('generic_json_parse_failed', {
      selectionId,
      requestId,
      stage: parsedContent.parseError || 'translation_field',
      expectedResponseFormat: 'json_object',
      possibleResponseFormatIncompatibility:
        parsedContent.parseError === 'invalid_json' || parsedContent.parseError === 'non_object',
      invalidFields: parsedContent.invalidFields,
      sourceTextIsSingleWord: singleWordInput,
      responseContentLength: content.length
    });
    throw new Error(buildGenericResponseFormatError(parsedContent.parseError));
  }

  if (parsedContent.invalidFields.length > 0) {
    debugLog('generic_optional_fields_ignored', {
      selectionId,
      requestId,
      sourceTextIsSingleWord: singleWordInput,
      invalidFields: parsedContent.invalidFields,
      responseContentLength: content.length
    });
  }

  return {
    translation: parsedContent.translation,
    lexicalDetails: parsedContent.lexicalDetails
  };
}

function emitEvent(tabId, payload, frameId = 0) {
  chrome.tabs.sendMessage(
    tabId,
    {
      type: TRANSLATION_MESSAGE_TYPES.TRANSLATION_EVENT,
      payload
    },
    { frameId },
    () => {
      void chrome.runtime.lastError;
    }
  );
}

function normalizeEndpoint(baseUrl) {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  const url = new URL(trimmed);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Use an HTTP or HTTPS Base URL.');
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
}

function supportsDashScopeStructuredStream(endpoint, model) {
  const url = new URL(endpoint)
  return url.protocol === 'https:'
    && (/^dashscope(?:-intl|-us)?\.aliyuncs\.com$/u.test(url.hostname) || url.hostname.endsWith('.maas.aliyuncs.com'))
    && url.pathname === '/compatible-mode/v1/chat/completions'
    && /^qwen(?:\d+(?:\.\d+)?)?-(?:flash|plus|max|turbo)(?:-|$)/iu.test(model)
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function normalizeErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'Translation failed. Please try again.';
}

function sanitizeRequestBodyForLog(requestBody) {
  if (!requestBody || typeof requestBody !== 'object') {
    return {};
  }

  const normalized = {
    ...requestBody
  };
  if (requestBody.response_format && typeof requestBody.response_format === 'object') {
    normalized.response_format = {
      ...requestBody.response_format
    };
  }

  if (Array.isArray(requestBody.messages)) {
    normalized.messages = requestBody.messages.map((message) => {
      const role = String(message?.role || '');
      const content = String(message?.content || '');

      if (role === 'system') {
        return {
          role,
          content
        };
      }

      return {
        role,
        contentDiagnostics: createSelectedTextDiagnostics(content)
      };
    });
  }

  return normalized;
}

function readNonStreamMessageContent(choice) {
  const content = choice?.message?.content;
  if (typeof content === 'string') {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const joined = content
      .map((part) => {
        if (typeof part?.text === 'string') {
          return part.text;
        }
        return '';
      })
      .join('');
    return joined.trim();
  }

  return '';
}

function buildGenericResponseFormatError(parseError) {
  if (parseError === 'invalid_json' || parseError === 'non_object') {
    return 'Generic-model response format mismatch: expected a JSON object in choices[0].message.content for response_format=json_object.';
  }

  if (parseError === 'missing_translation') {
    return 'Generic-model response format invalid: missing required non-empty "translation" string.';
  }

  return 'Generic-model response format invalid.';
}

function summarizeLexicalDetails(lexicalDetails) {
  if (!lexicalDetails || typeof lexicalDetails !== 'object') {
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

async function initDebugLoggingSetting() {
  try {
    const saved = await chrome.storage.sync.get([STORAGE_KEYS.DEBUG_LOGGING_ENABLED]);
    const enabled = saved?.[STORAGE_KEYS.DEBUG_LOGGING_ENABLED];
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

    const next = changes?.[STORAGE_KEYS.DEBUG_LOGGING_ENABLED]?.newValue;
    if (typeof next === 'boolean') {
      debugLoggingEnabled = next;
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
