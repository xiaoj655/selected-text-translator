export const ARCHIVE_FORMAT = 'selected-learning-archive';
export const ARCHIVE_VERSION = 1;
export const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;

const MAX_VOCABULARY_ENTRIES = 2000;
const MAX_MEMORY_ENTRIES = 500;
const MAX_HISTORY_ENTRIES = 20;
const MAX_TEXT_LENGTH = 12000;
const MAX_KEY_LENGTH = 512;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSafeTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
}

function clampText(value, limit) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

export function buildLearningArchive({ vocabularyEntries = [], translationMemory = {}, history = [], now = Date.now() } = {}) {
  return {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    exportedAt: isSafeTimestamp(now) ? now : Date.now(),
    sections: {
      vocabulary: { entries: Array.isArray(vocabularyEntries) ? vocabularyEntries.slice(0, MAX_VOCABULARY_ENTRIES) : [] },
      translationMemory: {
        entries: isObject(translationMemory) ? { ...translationMemory } : {},
      },
      history: { entries: Array.isArray(history) ? history.slice(-MAX_HISTORY_ENTRIES) : [] },
    },
  };
}

export function serializeLearningArchive(archive) {
  const text = JSON.stringify(archive);
  if (new TextEncoder().encode(text).length > MAX_ARCHIVE_BYTES) {
    throw new Error('Learning archive exceeds the 8 MB size limit.');
  }
  return text;
}

function parseVocabulary(section) {
  const raw = isObject(section) ? section.entries : null;
  if (!Array.isArray(raw)) throw new Error('Invalid learning archive: vocabulary section is malformed.');
  const entries = [];
  for (const value of raw.slice(0, MAX_VOCABULARY_ENTRIES)) {
    if (!isObject(value)) continue;
    const text = clampText(value.text, MAX_TEXT_LENGTH);
    const meaning = clampText(value.meaning, 2000);
    if (!text.trim() || !meaning.trim()) continue;
    entries.push({ ...value, text, meaning });
  }
  return entries;
}

function parseTranslationMemory(section) {
  const raw = isObject(section) ? section.entries : null;
  if (!isObject(raw)) throw new Error('Invalid learning archive: translation memory section is malformed.');
  const entries = {};
  for (const [key, value] of Object.entries(raw).slice(0, MAX_MEMORY_ENTRIES)) {
    if (!key || key.length > MAX_KEY_LENGTH || !isObject(value)) continue;
    if (typeof value.translatedText !== 'string' || !Number.isFinite(value.savedAt)) continue;
    entries[key] = value;
  }
  return entries;
}

function parseHistory(section) {
  const raw = isObject(section) ? section.entries : null;
  if (!Array.isArray(raw)) throw new Error('Invalid learning archive: history section is malformed.');
  const entries = [];
  for (const value of raw.slice(-MAX_HISTORY_ENTRIES)) {
    if (!isObject(value)) continue;
    const text = clampText(value.text, MAX_TEXT_LENGTH);
    if (!text.trim()) continue;
    entries.push({ ...value, text });
  }
  return entries;
}

function normalizedSections(raw) {
  const sections = isObject(raw) ? raw : {};
  return {
    vocabulary: isObject(sections.vocabulary) ? sections.vocabulary : { entries: [] },
    translationMemory: isObject(sections.translationMemory) ? sections.translationMemory : { entries: {} },
    history: isObject(sections.history) ? sections.history : { entries: [] },
  };
}

export function migrateArchive(data) {
  if (!isObject(data) || data.format !== ARCHIVE_FORMAT) {
    throw new Error('Invalid learning archive: expected a Selected learning archive.');
  }
  const version = data.version;
  if (version === ARCHIVE_VERSION || version === String(ARCHIVE_VERSION)) {
    return { ...data, version: ARCHIVE_VERSION, sections: normalizedSections(data.sections) };
  }
  if (version === undefined || version === null || version === 0 || version === '0') {
    return { ...data, version: ARCHIVE_VERSION, sections: normalizedSections(data.sections) };
  }
  if (typeof version === 'number' && Number.isInteger(version) && version > ARCHIVE_VERSION) {
    throw new Error(`Invalid learning archive: expected a Selected version ${ARCHIVE_VERSION} archive, got version ${version}. Please update Selected to open this file.`);
  }
  throw new Error(`Invalid learning archive: expected a Selected version ${ARCHIVE_VERSION} archive.`);
}

export function parseLearningArchive(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Invalid learning archive: the file is empty.');
  }
  if (new TextEncoder().encode(text).length > MAX_ARCHIVE_BYTES) {
    throw new Error('Invalid learning archive: file exceeds the 8 MB size limit.');
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Invalid learning archive: unable to read this file.');
  }
  const archive = migrateArchive(data);
  if (!isSafeTimestamp(archive.exportedAt)) {
    throw new Error(`Invalid learning archive: expected a Selected version ${ARCHIVE_VERSION} archive.`);
  }
  return {
    version: archive.version,
    exportedAt: archive.exportedAt,
    vocabularyEntries: parseVocabulary(archive.sections.vocabulary),
    translationMemory: parseTranslationMemory(archive.sections.translationMemory),
    historyEntries: parseHistory(archive.sections.history),
  };
}

export function mergeHistoryEntries(existing, incoming) {
  const merged = [];
  const seen = new Set();
  for (const entry of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    if (!isObject(entry) || !entry.text) continue;
    const id = String(entry.id || `${entry.createdAt || 0}:${entry.text}`);
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(entry);
  }
  return merged.slice(-MAX_HISTORY_ENTRIES);
}

function vocabularyKey(entry) {
  return `${entry.text}\n${entry.meaning}`;
}

function historyId(entry) {
  return String(entry.id || `${entry.createdAt || 0}:${entry.text}`);
}

export function planArchiveImport(existing = {}, incoming = {}) {
  const existingVocabulary = Array.isArray(existing.vocabularyEntries) ? existing.vocabularyEntries : [];
  const existingMemory = isObject(existing.translationMemory) ? existing.translationMemory : {};
  const existingHistory = Array.isArray(existing.history) ? existing.history : [];
  const incomingVocabulary = Array.isArray(incoming.vocabularyEntries) ? incoming.vocabularyEntries : [];
  const incomingMemory = isObject(incoming.translationMemory) ? incoming.translationMemory : {};
  const incomingHistory = Array.isArray(incoming.historyEntries) ? incoming.historyEntries : [];

  const seenVocabulary = new Set(existingVocabulary.map(vocabularyKey));
  const vocabularyEntries = [...existingVocabulary];
  let vocabularyAdded = 0;
  let vocabularyConflicts = 0;
  for (const entry of incomingVocabulary) {
    const key = vocabularyKey(entry);
    if (seenVocabulary.has(key)) {
      vocabularyConflicts += 1;
      continue;
    }
    seenVocabulary.add(key);
    vocabularyEntries.push(entry);
    vocabularyAdded += 1;
  }

  const translationMemory = { ...existingMemory };
  let memoryAdded = 0;
  let memoryConflicts = 0;
  for (const [key, value] of Object.entries(incomingMemory)) {
    if (Object.prototype.hasOwnProperty.call(translationMemory, key)) {
      memoryConflicts += 1;
      continue;
    }
    translationMemory[key] = value;
    memoryAdded += 1;
  }

  const seenHistory = new Set(existingHistory.map(historyId));
  let historyAdded = 0;
  for (const entry of incomingHistory) {
    const id = historyId(entry);
    if (seenHistory.has(id)) continue;
    seenHistory.add(id);
    historyAdded += 1;
  }
  const history = mergeHistoryEntries(existingHistory, incomingHistory);

  return {
    vocabularyEntries,
    translationMemory,
    history,
    counts: {
      vocabularyAdded,
      vocabularyConflicts,
      memoryAdded,
      memoryConflicts,
      historyAdded,
      totalConflicts: vocabularyConflicts + memoryConflicts,
    },
  };
}
