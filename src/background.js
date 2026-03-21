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
  usesStructuredOutputForModel
} from './translation-contracts.js';
import { readProviderSettings } from './provider-settings.js';

const LOG_PREFIX = '[selected-text-translation]';
let debugLoggingEnabled = true;

void initDebugLoggingSetting();

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.type !== TRANSLATION_MESSAGE_TYPES.START_TRANSLATION) {
    return false;
  }

  const tabId = sender?.tab?.id;
  if (typeof tabId !== 'number') {
    return false;
  }

  void handleStartTranslation({
    tabId,
    payload: message.payload
  });

  return false;
});

async function handleStartTranslation({ tabId, payload }) {
  const selectionId = String(payload?.selectionId || '');
  const requestId = String(payload?.requestId || '');
  const text = String(payload?.text || '');

  if (!selectionId || !requestId || !text.trim()) {
    emitEvent(tabId, {
      status: TRANSLATION_EVENT_STATUS.ERROR,
      selectionId,
      requestId,
      message: 'Unable to start translation for this selection.'
    });
    return;
  }

  const settings = await readProviderSettings();
  if (!settings.baseUrl || !settings.apiKey || !settings.model) {
    debugLog('missing_configuration', {
      selectionId,
      requestId,
      hasBaseUrl: Boolean(settings.baseUrl),
      hasApiKey: Boolean(settings.apiKey),
      hasModel: Boolean(settings.model)
    });

    emitEvent(tabId, {
      status: TRANSLATION_EVENT_STATUS.MISSING_CONFIGURATION,
      selectionId,
      requestId,
      message: 'Configure base_url, api_key, and model in extension settings.'
    });
    return;
  }

  const targetLanguage = getTargetLanguage(text);
  const usesStructuredOutput = usesStructuredOutputForModel(settings.model);

  debugLog('request_start', {
    selectionId,
    requestId,
    model: settings.model,
    targetLanguage,
    selectedText: createSelectedTextDiagnostics(text)
  });

  emitEvent(tabId, {
    status: TRANSLATION_EVENT_STATUS.STARTED,
    selectionId,
    requestId
  });

  const startedAt = Date.now();

  try {
    const endpoint = normalizeEndpoint(settings.baseUrl);
    const requestBody = usesStructuredOutput
      ? buildGenericRequest({
          model: settings.model,
          text
        })
      : buildQwenMtRequest({
          model: settings.model,
          text,
          targetLanguage
        });

    debugLog('request_payload', {
      selectionId,
      requestId,
      request: {
        endpoint,
        method: 'POST',
        headers: {
          Authorization: '[REDACTED]',
          'Content-Type': 'application/json'
        },
        body: sanitizeRequestBodyForLog(requestBody)
      }
    });

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const details = await safeReadText(response);
      throw new Error(
        `Translation request failed (${response.status}): ${truncate(details, 220)}`
      );
    }

    const translationResult = usesStructuredOutput
      ? await consumeNonStreamResponse({
          response,
          selectionId,
          requestId,
          sourceText: text
        })
      : {
          translation: await consumeStream({
            response,
            tabId,
            selectionId,
            requestId
          }),
          lexicalDetails: null
        };

    emitEvent(tabId, {
      status: TRANSLATION_EVENT_STATUS.SUCCESS,
      selectionId,
      requestId,
      sourceText: text,
      translatedText: translationResult.translation,
      lexicalDetails: translationResult.lexicalDetails
    });

    debugLog('request_success', {
      selectionId,
      requestId,
      elapsedMs: Date.now() - startedAt,
      translatedLength: translationResult.translation.length,
      lexicalFields: summarizeLexicalDetails(translationResult.lexicalDetails)
    });
  } catch (error) {
    const message = normalizeErrorMessage(error);
    debugLog('request_error', {
      selectionId,
      requestId,
      elapsedMs: Date.now() - startedAt,
      errorMessage: message
    });

    emitEvent(tabId, {
      status: TRANSLATION_EVENT_STATUS.ERROR,
      selectionId,
      requestId,
      message
    });
  }
}

async function consumeStream({ response, tabId, selectionId, requestId }) {
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
      break;
    }

    sseBuffer += decoder.decode(value, { stream: true });
    const lines = sseBuffer.split('\n');
    sseBuffer = lines.pop() || '';

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
        });
      }

      debugLog('stream_progress', {
        selectionId,
        requestId,
        chunkLength: delta.length,
        renderedLength: lastRenderedTranslation.length
      });
    }
  }

  const finalTranslation = qwenTranslation.trim();

  if (!finalTranslation) {
    throw new Error('Unable to read translated text from stream response.');
  }

  return finalTranslation;
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
      responseText: truncate(rawResponseText, 2200)
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
      responseText: truncate(rawResponseText, 2200),
      responseContent: truncate(content, 2200)
    });
    throw new Error(buildGenericResponseFormatError(parsedContent.parseError));
  }

  if (parsedContent.invalidFields.length > 0) {
    debugLog('generic_optional_fields_ignored', {
      selectionId,
      requestId,
      sourceTextIsSingleWord: singleWordInput,
      invalidFields: parsedContent.invalidFields,
      responseContent: truncate(content, 2200)
    });
  }

  return {
    translation: parsedContent.translation,
    lexicalDetails: parsedContent.lexicalDetails
  };
}

function emitEvent(tabId, payload) {
  chrome.tabs.sendMessage(
    tabId,
    {
      type: TRANSLATION_MESSAGE_TYPES.TRANSLATION_EVENT,
      payload
    },
    () => {
      void chrome.runtime.lastError;
    }
  );
}

function normalizeEndpoint(baseUrl) {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return `${trimmed}/chat/completions`;
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

function truncate(value, limit) {
  const text = String(value || '');
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}...`;
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
    debugLoggingEnabled = true;
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
