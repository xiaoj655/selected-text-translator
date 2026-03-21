export const STORAGE_KEYS = {
  BASE_URL: 'base_url',
  API_KEY: 'api_key',
  MODEL: 'model',
  DEBUG_LOGGING_ENABLED: 'debug_logging_enabled'
};

export const GENERIC_RESPONSE_FORMAT = Object.freeze({
  type: 'json_object'
});

export const TRANSLATION_SYSTEM_PROMPT =
  [
    'You are a professional multilingual translation engine.',
    'Return valid JSON only.',
    'Do not output markdown code blocks, comments, or extra prose.',
    'The top-level JSON object must always include "translation" as a non-empty string in Simplified Chinese.',
    'If and only if the user input is a single word, you may also include optional fields:',
    '"phonetic" (string),',
    '"definitions" (array of objects with required "meaning" string, optional "pos" string, and optional "example" object with "source" and "target" strings),',
    'and "contextual_analysis" (string in Simplified Chinese).',
    'For sentence or phrase input, return only {"translation":"..."} and omit lexical fields.',
    'For English, use American phonetic symbols.',
    'For Chinese, use standard Pinyin with tone marks.'
  ].join(' ');

export const TRANSLATION_MESSAGE_TYPES = {
  START_TRANSLATION: 'START_TRANSLATION',
  TRANSLATION_EVENT: 'TRANSLATION_EVENT'
};

export const TRANSLATION_EVENT_STATUS = {
  STARTED: 'started',
  STREAM: 'stream',
  SUCCESS: 'success',
  MISSING_CONFIGURATION: 'missing-configuration',
  ERROR: 'error'
};

export function containsChineseCharacters(text) {
  return /[\u3400-\u9fff]/u.test(text);
}

export function getTargetLanguage(text) {
  return containsChineseCharacters(text) ? 'English' : 'Chinese';
}

export function isQwenMtModel(model) {
  return String(model || '').toLowerCase().includes('qwen-mt');
}

export function usesStructuredOutputForModel(model) {
  return !isQwenMtModel(model);
}

export function buildQwenMtRequest({ model, text, targetLanguage }) {
  return {
    model,
    stream: true,
    messages: [
      {
        role: 'user',
        content: text
      }
    ],
    translation_options: {
      source_lang: 'auto',
      target_lang: targetLanguage
    }
  };
}

export function buildGenericRequest({ model, text }) {
  const payload = {
    model,
    stream: false,
    messages: [
      {
        role: 'system',
        content: TRANSLATION_SYSTEM_PROMPT
      },
      {
        role: 'user',
        content: text
      }
    ]
  };

  if (usesStructuredOutputForModel(model)) {
    payload.response_format = {
      ...GENERIC_RESPONSE_FORMAT
    };
  }

  if (shouldDisableThinkingForModel(model)) {
    payload.extra_body = {
      enable_thinking: false
    };
  }

  return payload;
}

export function createSelectedTextDiagnostics(text) {
  const normalized = String(text || '');
  return {
    length: normalized.length,
    preview: normalized.slice(0, 36)
  };
}

export function extractDeltaContent(streamPayload) {
  if (!streamPayload || typeof streamPayload !== 'object') {
    return '';
  }

  const choice = Array.isArray(streamPayload.choices)
    ? streamPayload.choices[0]
    : undefined;
  if (!choice || typeof choice !== 'object') {
    return '';
  }

  const delta = choice.delta;
  if (delta && typeof delta.content === 'string') {
    return delta.content;
  }

  const message = choice.message;
  if (message && typeof message.content === 'string') {
    return message.content;
  }

  return '';
}

export function extractGenericTranslation(rawContent) {
  return extractGenericResponse(rawContent).translation;
}

export function extractGenericResponse(rawContent, options = {}) {
  const normalized = String(rawContent || '').trim();
  if (!normalized) {
    return {
      translation: null,
      lexicalDetails: null,
      parseError: 'empty_content',
      invalidFields: []
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    return {
      translation: null,
      lexicalDetails: null,
      parseError: 'invalid_json',
      invalidFields: []
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      translation: null,
      lexicalDetails: null,
      parseError: 'non_object',
      invalidFields: []
    };
  }

  const translation = normalizeRequiredString(parsed.translation);
  if (!translation) {
    return {
      translation: null,
      lexicalDetails: null,
      parseError: 'missing_translation',
      invalidFields: []
    };
  }

  const allowLexicalFields = Boolean(options.allowLexicalFields);
  const normalizedLexicalDetails = allowLexicalFields
    ? normalizeLexicalDetails(parsed)
    : {
        lexicalDetails: null,
        invalidFields: []
      };

  return {
    translation,
    lexicalDetails: normalizedLexicalDetails.lexicalDetails,
    parseError: null,
    invalidFields: normalizedLexicalDetails.invalidFields
  };
}

export function isSingleWordInput(text) {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return false;
  }

  const tokens = normalized.split(/\s+/u).filter(Boolean);
  return tokens.length === 1;
}

function normalizeLexicalDetails(parsed) {
  const invalidFields = [];
  const lexicalDetails = {};

  const phonetic = normalizeOptionalString(parsed.phonetic);
  if (phonetic) {
    lexicalDetails.phonetic = phonetic;
  } else if (parsed.phonetic !== undefined) {
    pushInvalidField(invalidFields, 'phonetic');
  }

  const definitions = normalizeDefinitions(parsed.definitions, invalidFields);
  if (definitions) {
    lexicalDetails.definitions = definitions;
  }

  const contextualAnalysis = normalizeOptionalString(parsed.contextual_analysis);
  if (contextualAnalysis) {
    lexicalDetails.contextual_analysis = contextualAnalysis;
  } else if (parsed.contextual_analysis !== undefined) {
    pushInvalidField(invalidFields, 'contextual_analysis');
  }

  return {
    lexicalDetails: Object.keys(lexicalDetails).length > 0 ? lexicalDetails : null,
    invalidFields
  };
}

function normalizeDefinitions(value, invalidFields) {
  if (value === undefined) {
    return null;
  }

  if (!Array.isArray(value)) {
    pushInvalidField(invalidFields, 'definitions');
    return null;
  }

  const normalized = [];
  let hasInvalidItem = false;
  for (const item of value) {
    const normalizedItem = normalizeDefinitionItem(item);
    if (normalizedItem) {
      normalized.push(normalizedItem);
    } else {
      hasInvalidItem = true;
    }
  }

  if (normalized.length === 0) {
    if (value.length > 0) {
      pushInvalidField(invalidFields, 'definitions');
    }
    return null;
  }

  if (hasInvalidItem) {
    pushInvalidField(invalidFields, 'definitions');
  }

  return normalized;
}

function normalizeDefinitionItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return null;
  }

  const meaning = normalizeOptionalString(item.meaning);
  if (!meaning) {
    return null;
  }

  const normalized = {
    meaning
  };

  const pos = normalizeOptionalString(item.pos);
  if (pos) {
    normalized.pos = pos;
  }

  if (item.example !== undefined) {
    const example = normalizeDefinitionExample(item.example);
    if (!example) {
      return null;
    }
    normalized.example = example;
  }

  return normalized;
}

function normalizeDefinitionExample(example) {
  if (!example || typeof example !== 'object' || Array.isArray(example)) {
    return null;
  }

  const source = normalizeOptionalString(example.source);
  const target = normalizeOptionalString(example.target);
  if (!source || !target) {
    return null;
  }

  return {
    source,
    target
  };
}

function normalizeRequiredString(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeOptionalString(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function pushInvalidField(fields, field) {
  if (!fields.includes(field)) {
    fields.push(field);
  }
}

function shouldDisableThinkingForModel(model) {
  const normalized = String(model || '').trim().toLowerCase();
  if (!normalized.startsWith('qwen')) {
    return false;
  }

  return !normalized.includes('qwen-mt');
}
