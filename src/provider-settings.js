import { STORAGE_KEYS } from './translation-contracts.js';

export const DEFAULT_PROVIDER_SETTINGS = {
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'qwen-mt-flash'
};

export const PROVIDER_STORAGE_KEYS = [
  STORAGE_KEYS.BASE_URL,
  STORAGE_KEYS.API_KEY,
  STORAGE_KEYS.MODEL
];

export function normalizeProviderSettings(input = {}) {
  return {
    baseUrl: String(input.baseUrl || '').trim(),
    apiKey: String(input.apiKey || '').trim(),
    model: String(input.model || '').trim()
  };
}

export function validateProviderSettings(input = {}) {
  const settings = normalizeProviderSettings(input);
  const missingFields = [];

  if (!settings.baseUrl) {
    missingFields.push(STORAGE_KEYS.BASE_URL);
  }

  if (!settings.apiKey) {
    missingFields.push(STORAGE_KEYS.API_KEY);
  }

  if (!settings.model) {
    missingFields.push(STORAGE_KEYS.MODEL);
  }

  return {
    settings,
    missingFields,
    isValid: missingFields.length === 0
  };
}

export async function readProviderSettings() {
  const values = await chrome.storage.sync.get(PROVIDER_STORAGE_KEYS);

  const normalized = normalizeProviderSettings({
    baseUrl: values?.[STORAGE_KEYS.BASE_URL],
    apiKey: values?.[STORAGE_KEYS.API_KEY],
    model: values?.[STORAGE_KEYS.MODEL]
  });

  return {
    baseUrl: normalized.baseUrl || DEFAULT_PROVIDER_SETTINGS.baseUrl,
    apiKey: normalized.apiKey,
    model: normalized.model || DEFAULT_PROVIDER_SETTINGS.model
  };
}

export async function saveProviderSettings(input = {}) {
  const validation = validateProviderSettings(input);

  if (!validation.isValid) {
    return {
      ok: false,
      ...validation
    };
  }

  await chrome.storage.sync.set({
    [STORAGE_KEYS.BASE_URL]: validation.settings.baseUrl,
    [STORAGE_KEYS.API_KEY]: validation.settings.apiKey,
    [STORAGE_KEYS.MODEL]: validation.settings.model
  });

  return {
    ok: true,
    ...validation
  };
}

export async function readDisabledUrlPatterns() {
  const values = await chrome.storage.sync.get([STORAGE_KEYS.DISABLED_URL_PATTERNS]);
  const patterns = values?.[STORAGE_KEYS.DISABLED_URL_PATTERNS];

  if (!Array.isArray(patterns)) {
    return [];
  }

  return patterns.filter((p) => typeof p === 'string' && p.length > 0);
}

export async function saveDisabledUrlPatterns(patterns = []) {
  if (!Array.isArray(patterns)) {
    return {
      ok: false,
      error: 'Patterns must be an array'
    };
  }

  const validPatterns = patterns.filter((p) => typeof p === 'string' && p.length > 0);

  await chrome.storage.sync.set({
    [STORAGE_KEYS.DISABLED_URL_PATTERNS]: validPatterns
  });

  return {
    ok: true,
    patterns: validPatterns
  };
}
