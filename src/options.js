import { STORAGE_KEYS } from './translation-contracts.js';
import {
  readProviderSettings,
  saveProviderSettings
} from './provider-settings.js';

const form = document.getElementById('settings-form');
const statusEl = document.getElementById('status');
const baseUrlInput = document.getElementById('base_url');
const apiKeyInput = document.getElementById('api_key');
const modelInput = document.getElementById('model');
const debugLoggingInput = document.getElementById('debug_logging_enabled');
const disableLogsButton = document.getElementById('disable-logs');

void init();

async function init() {
  if (
    !form ||
    !statusEl ||
    !baseUrlInput ||
    !apiKeyInput ||
    !modelInput ||
    !debugLoggingInput ||
    !disableLogsButton
  ) {
    return;
  }

  await loadSettings();
  form.addEventListener('submit', onSubmit);
  disableLogsButton.addEventListener('click', onDisableLogs);
}

async function loadSettings() {
  const [providerSettings, saved] = await Promise.all([
    readProviderSettings(),
    chrome.storage.sync.get([
      STORAGE_KEYS.DEBUG_LOGGING_ENABLED
    ])
  ]);

  baseUrlInput.value = providerSettings.baseUrl;
  apiKeyInput.value = providerSettings.apiKey;
  modelInput.value = providerSettings.model;
  const debugEnabled = saved?.[STORAGE_KEYS.DEBUG_LOGGING_ENABLED];
  debugLoggingInput.checked = typeof debugEnabled === 'boolean' ? debugEnabled : true;
}

async function onSubmit(event) {
  event.preventDefault();

  const result = await saveProviderSettings({
    baseUrl: baseUrlInput.value,
    apiKey: apiKeyInput.value,
    model: modelInput.value
  });

  if (!result.ok) {
    setStatus('All fields are required.', '#c43f2f');
    return;
  }

  baseUrlInput.value = result.settings.baseUrl;
  apiKeyInput.value = result.settings.apiKey;
  modelInput.value = result.settings.model;

  await chrome.storage.sync.set({
    [STORAGE_KEYS.DEBUG_LOGGING_ENABLED]: debugLoggingInput.checked
  });

  setStatus('Settings saved.', '#17663e');
}

async function onDisableLogs() {
  debugLoggingInput.checked = false;
  await chrome.storage.sync.set({
    [STORAGE_KEYS.DEBUG_LOGGING_ENABLED]: false
  });
  setStatus('Debug logging disabled.', '#17663e');
}

function setStatus(text, color) {
  statusEl.textContent = text;
  statusEl.style.color = color;
}
