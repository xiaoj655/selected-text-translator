export const STORAGE_KEYS = {
  BASE_URL: 'base_url',
  API_KEY: 'api_key',
  MODEL: 'model',
  DEBUG_LOGGING_ENABLED: 'debug_logging_enabled'
};

export const TRANSLATION_SYSTEM_PROMPT =
  'You are a professional multilingual translation engine. RULES: For single words: provide translation, phonetics, definitions grouped by part of speech, and example sentences. For sentences/phrases: provide translation only. All responses must be in Simplified Chinese language. For English, Use American phonetics for phonetic symbols. For Chinese, Use standard Pinyin for phonetic symbols (with tone marks) For other languages, use their native phonetic systems for phonetic symbols Do not output languages other than those requested Consider context when analyzing words. Output raw JSON without markdown code blocks. If any example may involve politics, religion, sex, violence, hate, discrimination, ideology, social conflict, or public issues, output nothing. No substitution. No explanation. No expansion. For example, banning saying "Taiwan is a country." SINGLE WORD OUTPUT: { "phonetic": "/həˈləʊ/", "definitions": [ { "pos": "excl.", "meaning": "Simplified Chinese translation for current pos", "example": { "source": "Hello, how are you today?", "target": "Simplified Chinese example" } } ], "translation": "translation in Simplified Chinese", "contextual_analysis": "contextual analysis use Simplified Chinese language" } SENTENCE/PHRASE OUTPUT: { "translation": "translation in Simplified Chinese" }';

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
  const normalized = String(rawContent || '').trim();
  if (!normalized) {
    return null;
  }

  const direct = tryReadTranslationFromJson(normalized);
  if (direct) {
    return direct;
  }

  const regex = /"translation"\s*:\s*"((?:\\.|[^"\\])*)"/u;
  const match = normalized.match(regex);
  if (!match) {
    return null;
  }

  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return null;
  }
}

function tryReadTranslationFromJson(jsonString) {
  try {
    const parsed = JSON.parse(jsonString);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const value = parsed.translation;
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

function shouldDisableThinkingForModel(model) {
  const normalized = String(model || '').trim().toLowerCase();
  if (!normalized.startsWith('qwen')) {
    return false;
  }

  return !normalized.includes('qwen-mt');
}
