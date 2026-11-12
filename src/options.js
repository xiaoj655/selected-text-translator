import { bindConnectionControls } from './connection-controls.js'
import { createReadingControls } from './settings-controls.js'
import { STORAGE_KEYS } from './translation-contracts.js';
import {
  readProviderSettings,
  saveProviderSettings,
  readDisabledUrlPatterns,
  saveDisabledUrlPatterns
} from './provider-settings.js';

const form = document.getElementById('settings-form');
const statusEl = document.getElementById('status');
const baseUrlInput = document.getElementById('base_url');
const apiKeyInput = document.getElementById('api_key');
const modelInput = document.getElementById('model');
const debugLoggingInput = document.getElementById('debug_logging_enabled');
const disableLogsButton = document.getElementById('disable-logs');

const blacklistListEl = document.getElementById('blacklist-list');
const blacklistInputEl = document.getElementById('blacklist-input');
const blacklistAddButton = document.getElementById('blacklist-add');
const blacklistAddCurrentButton = document.getElementById('blacklist-add-current');

let blacklistPatterns = [];
let readingControls = null;

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

  try {
    await loadSettings();
    readingControls = await createReadingControls();
  } catch {
    setStatus('Unable to load settings. Please reopen this page.', '#c43f2f');
  }
  bindConnectionControls();
  form.addEventListener('submit', onSubmit);
  disableLogsButton.addEventListener('click', onDisableLogs);

  if (blacklistListEl && blacklistInputEl && blacklistAddButton && blacklistAddCurrentButton) {
    await loadBlacklist();
    blacklistAddButton.addEventListener('click', onBlacklistAdd);
    blacklistInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        onBlacklistAdd();
      }
    });
    blacklistAddCurrentButton.addEventListener('click', onBlacklistAddCurrent);
  }
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
  debugLoggingInput.checked = typeof debugEnabled === 'boolean' ? debugEnabled : false;
}

async function onSubmit(event) {
  event.preventDefault();

  try {
    if (readingControls && !(await readingControls.persist()).ok) return;
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
  } catch {
    setStatus('Unable to save settings. Please try again.', '#c43f2f');
  }
}

async function onDisableLogs() {
  try {
    debugLoggingInput.checked = false;
    await chrome.storage.sync.set({
      [STORAGE_KEYS.DEBUG_LOGGING_ENABLED]: false
    });
    setStatus('Debug logging disabled.', '#17663e');
  } catch {
    setStatus('操作失败，请重试。', '#c43f2f');
  }
}

function setStatus(text, color) {
  statusEl.textContent = text;
  statusEl.style.color = color;
}

async function loadBlacklist() {
  try {
    blacklistPatterns = await readDisabledUrlPatterns();
    renderBlacklist();
  } catch {
    setStatus('操作失败，请重试。', '#c43f2f');
  }
}

function renderBlacklist() {
  if (!blacklistListEl) {
    return;
  }

  blacklistListEl.innerHTML = '';

  if (blacklistPatterns.length === 0) {
    const emptyMsg = document.createElement('p');
    emptyMsg.className = 'blacklist-empty';
    emptyMsg.textContent = 'No URL patterns added yet.';
    blacklistListEl.appendChild(emptyMsg);
    return;
  }

  for (let i = 0; i < blacklistPatterns.length; i++) {
    const pattern = blacklistPatterns[i];
    const itemEl = createBlacklistItemEl(i, pattern);
    blacklistListEl.appendChild(itemEl);
  }
}

function createBlacklistItemEl(index, pattern) {
  const itemEl = document.createElement('div');
  itemEl.className = 'blacklist-item';
  itemEl.dataset.index = String(index);

  const patternEl = document.createElement('span');
  patternEl.className = 'blacklist-item-pattern';
  patternEl.textContent = pattern.startsWith('=') ? `${pattern.slice(1)}（仅此页）` : pattern;

  const editInput = document.createElement('input');
  editInput.type = 'text';
  editInput.className = 'blacklist-item-edit-input';
  editInput.value = pattern;

  const actionsEl = document.createElement('div');
  actionsEl.className = 'blacklist-item-actions';

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', () => startEditing(itemEl, index));

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', () => deletePattern(index));

  actionsEl.append(editBtn, deleteBtn);

  const editActionsEl = document.createElement('div');
  editActionsEl.className = 'blacklist-item-edit-actions';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', () => saveEdit(index, editInput.value));

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'secondary';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => cancelEditing(itemEl, pattern));

  editActionsEl.append(saveBtn, cancelBtn);

  itemEl.append(patternEl, editInput, actionsEl, editActionsEl);

  return itemEl;
}

function startEditing(itemEl, index) {
  itemEl.classList.add('editing');
  const editInput = itemEl.querySelector('.blacklist-item-edit-input');
  if (editInput) {
    editInput.focus();
    editInput.select();
  }
}

function cancelEditing(itemEl, originalPattern) {
  itemEl.classList.remove('editing');
  const editInput = itemEl.querySelector('.blacklist-item-edit-input');
  if (editInput) {
    editInput.value = originalPattern;
  }
}

async function saveEdit(index, newPattern) {
  try {
    const trimmed = String(newPattern || '').trim();
    if (!trimmed) {
      return;
    }

    blacklistPatterns[index] = trimmed;
    const result = await saveDisabledUrlPatterns(blacklistPatterns);
    if (result.ok) {
      renderBlacklist();
    }
  } catch {
    setStatus('操作失败，请重试。', '#c43f2f');
  }
}

async function deletePattern(index) {
  try {
    blacklistPatterns.splice(index, 1);
    const result = await saveDisabledUrlPatterns(blacklistPatterns);
    if (result.ok) {
      renderBlacklist();
    }
  } catch {
    setStatus('操作失败，请重试。', '#c43f2f');
  }
}

async function onBlacklistAdd() {
  try {
    const value = String(blacklistInputEl.value || '').trim();
    if (!value) {
      return;
    }

    if (!/^=?https?:\/\//.test(value)) {
      blacklistInputEl.value = '';
      return;
    }

    blacklistPatterns.push(value);
    const result = await saveDisabledUrlPatterns(blacklistPatterns);
    if (result.ok) {
      blacklistInputEl.value = '';
      renderBlacklist();
    }
  } catch {
    setStatus('操作失败，请重试。', '#c43f2f');
  }
}

async function onBlacklistAddCurrent() {
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const tab = tabs.find((item) => item.active && /^https?:\/\//.test(item.url || ''))
      || tabs.filter((item) => /^https?:\/\//.test(item.url || '')).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
    if (!tab || !tab.url) {
      return;
    }

    let url = tab.url;

    try {
      const urlObj = new URL(url);
      url = urlObj.origin + urlObj.pathname;
      if (urlObj.search) {
        url += urlObj.search;
      }
    } catch {
      return;
    }

    blacklistPatterns.push(url);
    const result = await saveDisabledUrlPatterns(blacklistPatterns);
    if (result.ok) {
      renderBlacklist();
    }
  } catch {}
}
