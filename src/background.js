import { createResultCache, createResultCacheKey } from './result-cache.js'
import { getContextSentence } from './context-sentence.js'
import { handleVocabularyMessage } from './vocabulary-messages.js'
import { handleProviderDiagnostics } from './provider-diagnostics.js'
import {
  STORAGE_KEYS,
  TRANSLATION_MESSAGE_TYPES,
  TRANSLATION_EVENT_STATUS,
  buildGenericRequest,
  buildQwenMtRequest,
  createSelectedTextDiagnostics,
  extractDeltaContent,
  extractGenericResponse,
  getTargetLanguage,
  isSingleWordInput,
  usesStructuredOutputForModel,
} from './translation-contracts.js'
import { readProviderSettings } from './provider-settings.js'
import { buildReadingRequest, getLearningModel, parseReadingResponse, readReadingSettings } from './reading-support.js'
import { handleSpeechMessage } from './speech.js'

const LOG_PREFIX = '[selected-text-translation]'
const activeRequests = new Map()
const resultCache = createResultCache()
const inflightCacheStates = new Map()
let cacheEpoch = 0
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync' || !['base_url', 'api_key', 'model', 'learning_model'].some((key) => key in changes)) return
  cacheEpoch += 1
  resultCache.clear()
})
let debugLoggingEnabled = false

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
  const key = `${tabId}:${frameId}`
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

async function handleStartTranslation({ tabId, frameId, key, payload }) {
  const selectionId = String(payload?.selectionId || '')
  const requestId = String(payload?.requestId || '')
  const text = String(payload?.text || '').trim()
  const kind = ['guide', 'pronunciation'].includes(payload?.kind) ? payload.kind : 'translate'
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
  const emit = (event, shouldCache = true) => {
    if (activeRequests.get(key) === active && !controller.signal.aborted) {
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
    if (kind !== 'translate') {
      const reading = await readReadingSettings()
      model = getLearningModel(settings.model, reading.learningModel)
      if (!model) {
        emit({ status: TRANSLATION_EVENT_STATUS.MISSING_CONFIGURATION,
          message: 'Add a general-purpose learning model in settings for hints and phonetics. You can still listen.' })
        return
      }
    }
    if (controller.signal.aborted) return
    const targetLanguage = getTargetLanguage(text)
    const isQwenMtRequest = kind === 'translate' && !usesStructuredOutputForModel(model)
    const requestBody = kind !== 'translate'
      ? buildReadingRequest({ model, text, context: payload?.context,
          contextStart: payload?.contextStart, contextEnd: payload?.contextEnd, kind })
      : isQwenMtRequest
        ? buildQwenMtRequest({ model, text, targetLanguage })
        : buildGenericRequest({ model, text })
    const endpoint = normalizeEndpoint(settings.baseUrl)
    try {
      cacheKey = await createResultCacheKey({ kind, endpoint, apiKey: settings.apiKey, requestBody,
        context: payload?.context, contextStart: payload?.contextStart, contextEnd: payload?.contextEnd })
    } catch { }
    if (controller.signal.aborted || activeRequests.get(key) !== active) return
    const canUseCache = Boolean(cacheKey && requestEpoch === cacheEpoch)
    if (canUseCache && payload?.forceRefresh === true) resultCache.delete(cacheKey)
    const cached = payload?.forceRefresh !== true && canUseCache && resultCache.get(cacheKey)
    if (cached) {
      emit(cached, false)
      debugLog('result_reused', { selectionId, requestId, kind, elapsedMs: Date.now() - startedAt })
      return
    }
    if (canUseCache) cacheLease = acquireCacheWrite(cacheKey, payload?.forceRefresh === true)
    emit({ status: TRANSLATION_EVENT_STATUS.STARTED })
    debugLog('request_start', { selectionId, requestId, kind, model,
      selectedText: createSelectedTextDiagnostics(text) })
    debugLog('request_payload', { selectionId, requestId,
      request: { host: new URL(endpoint).host, body: sanitizeRequestBodyForLog(requestBody) } })
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    })
    if (!response.ok) {
      const help = { 400: 'Check that the model supports this request format.', 401: 'Check your API key.', 403: 'Check model access.',
        404: 'Check the Base URL and model name.', 429: 'Rate limit reached. Please try again shortly.' }
      throw new Error(`Request failed (${response.status}). ${help[response.status] || 'Please try again.'}`)
    }
    if (kind !== 'translate') {
      const json = await response.json()
      const content = readNonStreamMessageContent(json?.choices?.[0])
      const result = parseReadingResponse(content, kind, { text })
      emit({ status: TRANSLATION_EVENT_STATUS.SUCCESS, kind, result })
      return
    }
    const translationResult = isQwenMtRequest
      ? requestBody.stream
        ? { translation: await consumeStream({ response, tabId, frameId, selectionId, requestId,
            isActive: () => activeRequests.get(key) === active && !controller.signal.aborted }), lexicalDetails: null }
        : { translation: await consumeQwenMtNonStreamResponse({ response, selectionId, requestId }), lexicalDetails: null }
      : await consumeNonStreamResponse({ response, selectionId, requestId, sourceText: text })
    emit({ status: TRANSLATION_EVENT_STATUS.SUCCESS, sourceText: text,
      translatedText: translationResult.translation, lexicalDetails: translationResult.lexicalDetails })
    debugLog('request_success', { selectionId, requestId, elapsedMs: Date.now() - startedAt,
      translatedLength: translationResult.translation.length,
      lexicalFields: summarizeLexicalDetails(translationResult.lexicalDetails) })
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

async function consumeStream({ response, tabId, frameId, selectionId, requestId, isActive }) {
  if (!response.body) {
    throw new Error('qwen-mt response did not include a stream body.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let qwenTranslation = '';
  let lastRenderedTranslation = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      sseBuffer += decoder.decode();
      if (!sseBuffer.trim()) break;
    }

    if (!isActive()) break;
    sseBuffer += decoder.decode(value, { stream: true });
    const lines = sseBuffer.split('\n');
    sseBuffer = done ? '' : lines.pop() || '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || !line.startsWith('data:')) {
        continue;
      }

      const rawData = line.slice(5).trim();
      if (!rawData || rawData === '[DONE]') {
        continue;
      }

      let payload;
      try {
        payload = JSON.parse(rawData);
      } catch {
        continue;
      }

      const delta = extractDeltaContent(payload);
      if (!delta) {
        continue;
      }

      qwenTranslation += delta;
      const partial = qwenTranslation.trim();
      if (partial) {
        lastRenderedTranslation = partial;
        emitEvent(tabId, {
          status: TRANSLATION_EVENT_STATUS.STREAM,
          selectionId,
          requestId,
          translatedText: partial
        }, frameId);
      }

      debugLog('stream_progress', {
        selectionId,
        requestId,
        chunkLength: delta.length,
        renderedLength: lastRenderedTranslation.length
      });
    }
    if (done) break;
  }

  const finalTranslation = qwenTranslation.trim();

  if (!finalTranslation) {
    throw new Error('Unable to read translated text from stream response.');
  }

  return finalTranslation;
}

async function consumeQwenMtNonStreamResponse({ response, selectionId, requestId }) {
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

  return content;
}

async function consumeNonStreamResponse({ response, selectionId, requestId, sourceText }) {
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
  const content = readNonStreamMessageContent(choice);

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
      responseLength: rawResponseText.length,
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
