import { readProviderSettings, saveProviderSettings } from './provider-settings.js';

const form = document.getElementById('popup-settings-form');
const statusEl = document.getElementById('status');
const baseUrlInput = document.getElementById('base_url');
const apiKeyInput = document.getElementById('api_key');
const modelInput = document.getElementById('model');
const STATUS_COLOR_SUCCESS = '#17663e';
const STATUS_COLOR_ERROR = '#c43f2f';

let lastSavedSettings = null;
let persistQueue = Promise.resolve();

void init();

async function init() {
  if (!form || !statusEl || !baseUrlInput || !apiKeyInput || !modelInput) {
    return;
  }

  await loadSettings();
  form.addEventListener('submit', onSubmit);
  baseUrlInput.addEventListener('blur', onInputBlur);
  apiKeyInput.addEventListener('blur', onInputBlur);
  modelInput.addEventListener('blur', onInputBlur);
}

async function loadSettings() {
  const settings = await readProviderSettings();
  baseUrlInput.value = settings.baseUrl;
  apiKeyInput.value = settings.apiKey;
  modelInput.value = settings.model;
  lastSavedSettings = settings;
}

function onSubmit(event) {
  event.preventDefault();
  void queuePersist('submit');
}

function onInputBlur() {
  void queuePersist('blur');
}

function queuePersist(reason) {
  persistQueue = persistQueue
    .then(async () => {
      await persistCurrentForm(reason);
    })
    .catch(() => {
      setStatus('Failed to save settings.', STATUS_COLOR_ERROR);
    });
}

async function persistCurrentForm(reason) {
  const currentSettings = readCurrentInputSettings();
  if (reason === 'blur' && areSameSettings(currentSettings, lastSavedSettings)) {
    return;
  }

  const result = await saveProviderSettings({
    baseUrl: baseUrlInput.value,
    apiKey: apiKeyInput.value,
    model: modelInput.value
  });

  if (!result.ok) {
    if (reason === 'blur') {
      setStatus('Fill all fields to auto-save.', STATUS_COLOR_ERROR);
      return;
    }

    setStatus('All fields are required.', STATUS_COLOR_ERROR);
    return;
  }

  baseUrlInput.value = result.settings.baseUrl;
  apiKeyInput.value = result.settings.apiKey;
  modelInput.value = result.settings.model;
  lastSavedSettings = result.settings;

  if (reason === 'blur') {
    setStatus('Settings auto-saved.', STATUS_COLOR_SUCCESS);
    return;
  }

  setStatus('Settings saved.', STATUS_COLOR_SUCCESS);
}

function readCurrentInputSettings() {
  return {
    baseUrl: String(baseUrlInput.value || '').trim(),
    apiKey: String(apiKeyInput.value || '').trim(),
    model: String(modelInput.value || '').trim()
  };
}

function areSameSettings(left, right) {
  if (!left || !right) {
    return false;
  }

  return (
    left.baseUrl === right.baseUrl &&
    left.apiKey === right.apiKey &&
    left.model === right.model
  );
}

function setStatus(text, color) {
  statusEl.textContent = text;
  statusEl.style.color = color;
}
