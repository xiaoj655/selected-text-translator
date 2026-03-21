import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const popupHtmlSource = readFileSync(new URL('../src/popup.html', import.meta.url), 'utf8');
const popupJsSource = readFileSync(new URL('../src/popup.js', import.meta.url), 'utf8');
const optionsSource = readFileSync(new URL('../src/options.js', import.meta.url), 'utf8');
const backgroundSource = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');

test('manifest action uses popup entry', () => {
  assert.equal(manifest.action.default_popup, 'src/popup.html');
});

test('popup contains provider input fields and status region', () => {
  assert.match(popupHtmlSource, /id="base_url"/);
  assert.match(popupHtmlSource, /id="api_key"/);
  assert.match(popupHtmlSource, /id="model"/);
  assert.match(popupHtmlSource, /id="status"/);
});

test('popup script uses shared provider-settings helpers', () => {
  assert.match(
    popupJsSource,
    /import\s*\{\s*readProviderSettings,\s*saveProviderSettings\s*\}\s*from\s*'\.\/provider-settings\.js'/
  );
  assert.match(popupJsSource, /const settings = await readProviderSettings\(\)/);
  assert.match(popupJsSource, /const result = await saveProviderSettings\(/);
});

test('options script reuses shared provider-settings helpers and keeps debug toggle', () => {
  assert.match(
    optionsSource,
    /import\s*\{\s*readProviderSettings,\s*saveProviderSettings\s*\}\s*from\s*'\.\/provider-settings\.js'/
  );
  assert.match(optionsSource, /const \[providerSettings, saved\] = await Promise\.all\(\[/);
  assert.match(optionsSource, /const result = await saveProviderSettings\(/);
  assert.match(optionsSource, /disableLogsButton\.addEventListener\('click',\s*onDisableLogs\)/);
});

test('background uses shared provider settings for translation requests', () => {
  assert.match(
    backgroundSource,
    /import\s*\{\s*readProviderSettings\s*\}\s*from\s*'\.\/provider-settings\.js'/
  );
  assert.match(backgroundSource, /const settings = await readProviderSettings\(\)/);
  assert.match(backgroundSource, /normalizeEndpoint\(settings\.baseUrl\)/);
  assert.match(backgroundSource, /Authorization:\s*`Bearer \$\{settings\.apiKey\}`/);
  assert.match(backgroundSource, /model:\s*settings\.model/);
});
