import { bindConnectionControls } from './connection-controls.js'
import { matchesUrlPattern } from './url-patterns.js'
import { createReadingControls } from './settings-controls.js'
import { readProviderSettings, saveProviderSettings, readDisabledUrlPatterns, saveDisabledUrlPatterns } from './provider-settings.js';

const form = document.getElementById('popup-settings-form');
const statusEl = document.getElementById('status');
const baseUrlInput = document.getElementById('base_url');
const apiKeyInput = document.getElementById('api_key');
const modelInput = document.getElementById('model');
const currentUrlEl = document.getElementById('current-url');
const disableCurrentBtn = document.getElementById('disable-current');
const disableCurrentSubpathBtn = document.getElementById('disable-current-subpath');
const enableCurrentBtn = document.getElementById('enable-current');
const pageStatusEl = document.getElementById('page-status');
const disableButtonsEl = document.getElementById('disable-buttons');
const enableButtonEl = document.getElementById('enable-button');
const STATUS_COLOR_SUCCESS = '#17663e';
const STATUS_COLOR_ERROR = '#c43f2f';

let lastSavedSettings = null;
let persistQueue = Promise.resolve();
let currentTabUrl = null;
let readingControls = null;

void init();

async function init() {
  if (!form || !statusEl || !baseUrlInput || !apiKeyInput || !modelInput) {
    return;
  }

  try {
    await loadSettings();
    readingControls = await createReadingControls({ autoSave: true });
  } catch {
    setStatus('Unable to load settings. Please reopen the extension.', STATUS_COLOR_ERROR);
  }
  document.getElementById('open-settings')?.addEventListener('click', () => {
    chrome.runtime.openOptionsPage(() => { void chrome.runtime.lastError; });
  });
  document.getElementById('open-library')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_LIBRARY' }, () => { void chrome.runtime.lastError; });
  });
  bindConnectionControls();
  form.addEventListener('submit', onSubmit);
  baseUrlInput.addEventListener('blur', onInputBlur);
  apiKeyInput.addEventListener('blur', onInputBlur);
  modelInput.addEventListener('blur', onInputBlur);

  if (currentUrlEl && disableCurrentBtn && disableCurrentSubpathBtn && enableCurrentBtn) {
    await loadCurrentTabUrl();
    disableCurrentBtn.addEventListener('click', onDisableCurrent);
    disableCurrentSubpathBtn.addEventListener('click', onDisableCurrentSubpath);
    enableCurrentBtn.addEventListener('click', onEnableCurrent);
  }
}

async function loadSettings() {
  const settings = await readProviderSettings();
  baseUrlInput.value = settings.baseUrl;
  apiKeyInput.value = settings.apiKey;
  modelInput.value = settings.model;
  lastSavedSettings = settings;
  const providerDetailsEl = document.getElementById('provider-details');
  if (providerDetailsEl) providerDetailsEl.open = !settings.apiKey;
}

async function loadCurrentTabUrl() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && /^https?:\/\//.test(tab.url || '')) {
      currentTabUrl = tab.url;
      const url = new URL(tab.url);
      currentUrlEl.textContent = url.origin + url.pathname;
      await loadPageStatus(url.href);
      return;
    }
  } catch {}
  currentTabUrl = null;
  currentUrlEl.textContent = '当前页面不支持划词阅读';
  pageStatusEl.classList.add('hidden');
  disableButtonsEl.style.display = 'none';
  enableButtonEl.style.display = 'none';
}

async function loadPageStatus(url) {
  const patterns = await readDisabledUrlPatterns();
  const matchResult = findMatchingPattern(url, patterns);

  if (matchResult) {
    pageStatusEl.classList.remove('hidden', 'enabled');
    pageStatusEl.classList.add('disabled');
    pageStatusEl.querySelector('.page-status-text').textContent = '已停用';
    disableButtonsEl.style.display = 'none';
    enableButtonEl.style.display = 'block';
    enableCurrentBtn.dataset.pattern = matchResult.pattern;
    enableCurrentBtn.textContent = matchResult.pattern.startsWith('=') ? '重新启用此页' : '移除匹配的停用规则';
  } else {
    pageStatusEl.classList.remove('hidden', 'disabled');
    pageStatusEl.classList.add('enabled');
    pageStatusEl.querySelector('.page-status-text').textContent = '已启用';
    disableButtonsEl.style.display = 'flex';
    enableButtonEl.style.display = 'none';
  }
}

function findMatchingPattern(url, patterns) {
  for (const pattern of patterns) {
    if (matchesUrlPattern(url, pattern)) {
      return { pattern };
    }
  }
  return null;
}

async function onDisableCurrent() {
  try {
    const pattern = `=${currentTabUrl || getOriginPathname()}`;
    await addToBlacklist(pattern);
  } catch {
    setStatus('操作失败，请重试。', '#c43f2f');
  }
}

async function onDisableCurrentSubpath() {
  try {
    const pattern = getOriginPathname();
    await addToBlacklist(pattern);
  } catch {
    setStatus('操作失败，请重试。', '#c43f2f');
  }
}

async function onEnableCurrent() {
  try {
    const pattern = enableCurrentBtn.dataset.pattern;
    if (!pattern) {
      return;
    }

    const patterns = await readDisabledUrlPatterns();
    const remaining = patterns.filter((item) => !matchesUrlPattern(currentTabUrl, item));
    const result = await saveDisabledUrlPatterns(remaining);
    if (result.ok) {
      setStatus('Enabled on this page.', STATUS_COLOR_SUCCESS);
      if (currentTabUrl) {
        await loadPageStatus(currentTabUrl);
      }
    } else {
      setStatus('Failed to enable.', STATUS_COLOR_ERROR);
    }
  } catch {
    setStatus('操作失败，请重试。', '#c43f2f');
  }
}

function getOriginPathname() {
  const urlStr = currentTabUrl || currentUrlEl.textContent;
  try {
    const url = new URL(urlStr);
    return url.origin + url.pathname;
  } catch {
    return urlStr;
  }
}

async function addToBlacklist(pattern) {
  if (!pattern) {
    return;
  }

  const patterns = await readDisabledUrlPatterns();
  if (patterns.includes(pattern)) {
    setStatus('Already disabled.', STATUS_COLOR_ERROR);
    return;
  }

  patterns.push(pattern);
  const result = await saveDisabledUrlPatterns(patterns);
  if (result.ok) {
    setStatus('Disabled on this page.', STATUS_COLOR_SUCCESS);
    if (currentTabUrl) {
      await loadPageStatus(currentTabUrl);
    }
  } else {
    setStatus('Failed to disable.', STATUS_COLOR_ERROR);
  }
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

  if (readingControls && !(await readingControls.persist()).ok) return;
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
