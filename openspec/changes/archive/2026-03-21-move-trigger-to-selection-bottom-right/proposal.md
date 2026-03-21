## Why

The floating trigger currently appears near the upper edge of the selection, which makes the hover target feel detached from the point where reading focus usually ends. Moving the trigger to the lower-right corner of the selected text should reduce pointer travel and make the hover-to-translate interaction feel more natural.

## What Changes

- Change the selected-text floating trigger placement so it anchors to the lower-right corner of the current selection instead of the upper-right edge.
- Preserve existing viewport clamping so the trigger stays visible even when the selection is near the page or viewport boundary.
- Update the selected-text translation behavior spec to define the lower-right trigger placement expectation.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `selected-text-translation`: refine the floating trigger placement requirement so the affordance appears at the selected text's lower-right corner while remaining viewport-safe.

## Impact

- Affects the content-script positioning logic in `src/content.js`.
- Changes the behavioral contract documented in `openspec/specs/selected-text-translation/spec.md`.
- Will require targeted verification around multi-line selections and viewport-edge placements.
