import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const backgroundSource = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');
const contentSource = readFileSync(new URL('../src/content.js', import.meta.url), 'utf8');
const optionsSource = readFileSync(new URL('../src/options.js', import.meta.url), 'utf8');

test('request success and error logs include selectionId + requestId correlation fields', () => {
  assert.match(
    backgroundSource,
    /debugLog\('request_success',\s*\{[^}]*selectionId[^}]*requestId/s
  );
  assert.match(
    backgroundSource,
    /debugLog\('request_error',\s*\{[^}]*selectionId[^}]*requestId/s
  );
  assert.match(
    contentSource,
    /debugLog\('request_success',\s*\{[^}]*selectionId[^}]*requestId/s
  );
  assert.match(
    contentSource,
    /debugLog\('request_error',\s*\{[^}]*selectionId[^}]*requestId/s
  );
});

test('logs do not include raw api key fields', () => {
  assert.doesNotMatch(backgroundSource, /debugLog\([^)]*settings\.apiKey/s);
  assert.doesNotMatch(backgroundSource, /debugLog\([^)]*api_key/s);
  assert.doesNotMatch(contentSource, /debugLog\([^)]*api_key/s);
});

test('selected text is logged as diagnostics rather than raw text', () => {
  assert.match(
    backgroundSource,
    /selectedText:\s*createSelectedTextDiagnostics\(text\)/
  );
  assert.match(
    contentSource,
    /selectedText:\s*createSelectedTextDiagnostics\(state\.activeSelection\.text\)/
  );
});

test('request payload debug log includes prompt and redacts user content', () => {
  assert.match(backgroundSource, /debugLog\('request_payload'/);
  assert.match(
    backgroundSource,
    /body:\s*sanitizeRequestBodyForLog\(requestBody\)/
  );
  assert.match(backgroundSource, /if \(role === 'system'\)/);
  assert.match(
    backgroundSource,
    /contentDiagnostics:\s*createSelectedTextDiagnostics\(content\)/
  );
});

test('generic JSON parse failures are logged with response text', () => {
  assert.match(backgroundSource, /debugLog\('generic_json_parse_failed'/);
  assert.match(backgroundSource, /responseText:\s*truncate\(rawResponseText,\s*2200\)/);
});

test('debug logs are controlled by debug_logging_enabled switch', () => {
  assert.match(backgroundSource, /STORAGE_KEYS\.DEBUG_LOGGING_ENABLED/);
  assert.match(backgroundSource, /if\s*\(!debugLoggingEnabled\)\s*\{\s*return;\s*\}/s);
  assert.match(contentSource, /DEBUG_LOGGING_KEY\s*=\s*'debug_logging_enabled'/);
  assert.match(contentSource, /if\s*\(!debugLoggingEnabled\)\s*\{\s*return;\s*\}/s);
});

test('options page supports one-click log disable', () => {
  assert.match(optionsSource, /disableLogsButton\.addEventListener\('click',\s*onDisableLogs\)/);
  assert.match(optionsSource, /\[STORAGE_KEYS\.DEBUG_LOGGING_ENABLED\]:\s*false/);
});
