import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const contentSource = readFileSync(new URL('../src/content.js', import.meta.url), 'utf8');

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function pickTriggerAnchorRect(clientRects, fallbackRect) {
  for (let index = clientRects.length - 1; index >= 0; index -= 1) {
    const rect = clientRects[index];
    if (!rect) {
      continue;
    }
    if (rect.width === 0 && rect.height === 0) {
      continue;
    }
    return rect;
  }
  return fallbackRect;
}

function computeTriggerPosition({ anchorRect, viewportWidth, viewportHeight }) {
  const placementGapPx = 10;
  const triggerSizePx = 16;
  const viewportMarginPx = 8;
  const preferredLeft = anchorRect.right + placementGapPx;
  const preferredTop = anchorRect.bottom + placementGapPx;
  const maxLeft = viewportWidth - triggerSizePx - viewportMarginPx;
  const maxTop = viewportHeight - triggerSizePx - viewportMarginPx;

  return {
    left: clamp(preferredLeft, viewportMarginPx, maxLeft),
    top: clamp(preferredTop, viewportMarginPx, maxTop)
  };
}

test('content script computes trigger anchor from last non-empty client rect with fallback', () => {
  assert.match(contentSource, /function getTriggerAnchorRect\(range,\s*fallbackRect\)/);
  assert.match(contentSource, /const lastRect = getLastNonEmptyClientRect\(range\)/);
  assert.match(contentSource, /return cloneRect\(fallbackRect\)/);
  assert.match(contentSource, /for \(let index = rects\.length - 1; index >= 0; index -= 1\)/);
});

test('content script positions trigger from lower-right anchor and keeps clamp behavior', () => {
  assert.match(contentSource, /const preferredLeft = selectionRect\.right \+ PLACEMENT_GAP_PX/);
  assert.match(contentSource, /const preferredTop = selectionRect\.bottom \+ PLACEMENT_GAP_PX/);
  assert.match(contentSource, /const left = clamp\(\s*preferredLeft,/s);
  assert.match(contentSource, /const top = clamp\(\s*preferredTop,/s);
});

test('single-line selection keeps trigger at lower-right with configured gap', () => {
  const anchorRect = {
    left: 30,
    top: 80,
    right: 140,
    bottom: 96,
    width: 110,
    height: 16
  };
  const result = computeTriggerPosition({
    anchorRect,
    viewportWidth: 1200,
    viewportHeight: 700
  });

  assert.deepEqual(result, {
    left: 150,
    top: 106
  });
});

test('multi-line selection anchor prefers last visual line', () => {
  const fallbackRect = {
    left: 100,
    top: 100,
    right: 260,
    bottom: 180,
    width: 160,
    height: 80
  };
  const clientRects = [
    {
      left: 100,
      top: 100,
      right: 220,
      bottom: 120,
      width: 120,
      height: 20
    },
    {
      left: 100,
      top: 140,
      right: 180,
      bottom: 160,
      width: 80,
      height: 20
    }
  ];
  const anchorRect = pickTriggerAnchorRect(clientRects, fallbackRect);

  assert.deepEqual(anchorRect, clientRects[1]);
  assert.deepEqual(
    computeTriggerPosition({
      anchorRect,
      viewportWidth: 1200,
      viewportHeight: 700
    }),
    {
      left: 190,
      top: 170
    }
  );
});

test('viewport-edge selections clamp to nearest visible trigger position', () => {
  const anchorRect = {
    left: 760,
    top: 560,
    right: 790,
    bottom: 590,
    width: 30,
    height: 30
  };

  const result = computeTriggerPosition({
    anchorRect,
    viewportWidth: 800,
    viewportHeight: 600
  });

  assert.deepEqual(result, {
    left: 776,
    top: 576
  });
});
