## 1. Popup Surface Setup

- [x] 1.1 Add `action.default_popup` in `manifest.json` and create popup entry files (`src/popup.html`, `src/popup.js`)
- [x] 1.2 Build a compact popup form with `base_url`, `api_key`, and `model` inputs plus save/status UI
- [x] 1.3 Load existing `base_url`, `api_key`, and `model` values from `chrome.storage.sync` when the popup opens

## 2. Shared Provider Settings Logic

- [x] 2.1 Extract or add shared provider-settings helpers for reading, validating, and saving `base_url`, `api_key`, and `model`
- [x] 2.2 Update the popup script to use the shared helpers for validation and persistence
- [x] 2.3 Update the options-page settings flow to reuse the same provider-field helpers and keep advanced controls working

## 3. Compatibility and Behavior Checks

- [x] 3.1 Verify popup save writes the existing storage keys (`base_url`, `api_key`, `model`) without contract changes
- [x] 3.2 Verify background translation requests continue reading popup-saved values without request-shape regression
- [x] 3.3 Verify the options page loads values saved from the popup and remains functional for existing non-popup controls

## 4. Validation and Manual QA

- [x] 4.1 Validate popup required-field behavior: empty trimmed fields block save and show error feedback
- [x] 4.2 Validate popup success feedback and persistence across popup reopen
- [x] 4.3 Run an extension manual test pass for click icon -> edit settings -> save -> trigger translation flow
