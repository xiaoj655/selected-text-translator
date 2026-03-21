import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const contentSource = readFileSync(new URL('../src/content.js', import.meta.url), 'utf8');

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function computeClampedCardWidth(rawWidth, viewportWidth) {
  const minCardWidthPx = 220;
  const maxCardWidthPx = 720;
  const viewportMarginPx = 8;
  const viewportMax = Math.max(120, viewportWidth - viewportMarginPx * 2);
  const minWidth = Math.min(minCardWidthPx, viewportMax);
  const maxWidth = Math.max(minWidth, Math.min(maxCardWidthPx, viewportMax));
  return clamp(Math.round(rawWidth), minWidth, maxWidth);
}

test('content card styles enforce viewport-safe max height and scrolling', () => {
  assert.match(contentSource, /max-height: calc\(100vh - \$\{VIEWPORT_MARGIN_PX \* 2\}px\);/);
  assert.match(contentSource, /overflow-y: auto;/);
  assert.match(contentSource, /overflow-x: hidden;/);
  assert.match(contentSource, /box-sizing: border-box;/);
});

test('content script wires resize handle and pointer drag handlers', () => {
  assert.match(contentSource, /className = 'stt-card-resize-handle'/);
  assert.match(contentSource, /handle\.addEventListener\('pointerdown',\s*onCardResizePointerDown\)/);
  assert.match(contentSource, /function onCardResizePointerMove\(event\)/);
  assert.match(contentSource, /function onCardResizePointerEnd\(event\)/);
  assert.match(contentSource, /queuePersistCardWidth\(persistedWidth\)/);
});

test('content script loads and persists resized width using sync storage', () => {
  assert.match(contentSource, /CARD_WIDTH_STORAGE_KEY\s*=\s*'translation_card_width_px'/);
  assert.match(contentSource, /chrome\.storage\.sync\.get\(\[CARD_WIDTH_STORAGE_KEY\]\)/);
  assert.match(contentSource, /chrome\.storage\.sync\.set\(\{\s*\[CARD_WIDTH_STORAGE_KEY\]:\s*widthPx/s);
});

test('card width clamping enforces bounds and adapts to viewport width', () => {
  assert.equal(computeClampedCardWidth(500, 1200), 500);
  assert.equal(computeClampedCardWidth(120, 1200), 220);
  assert.equal(computeClampedCardWidth(1200, 1200), 720);
  assert.equal(computeClampedCardWidth(500, 260), 244);
  assert.equal(computeClampedCardWidth(10, 200), 184);
});

test('positioning uses effective rendered width after width application', () => {
  assert.match(contentSource, /applyCardWidth\(\);/);
  assert.match(contentSource, /const cardWidth = Math\.max\(state\.cardEl\.offsetWidth,\s*1\);/);
  assert.match(contentSource, /const measuredHeight = Math\.max\(state\.cardEl\.offsetHeight, MIN_CARD_HEIGHT_PX\);/);
});

test('loading, status, and result states all preserve resize affordance', () => {
  assert.match(contentSource, /function renderLoadingCard\(message\)[\s\S]*ensureCardResizeHandle\(\);/);
  assert.match(contentSource, /function renderStatusCard\(message\)[\s\S]*ensureCardResizeHandle\(\);/);
  assert.match(
    contentSource,
    /function renderSuccessCard\(sourceText, translatedText, lexicalDetails\)[\s\S]*ensureCardResizeHandle\(\);/
  );
});
