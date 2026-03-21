## 1. Popup Auto-Save Flow

- [x] 1.1 Refactor `src/popup.js` to extract a shared persist function used by both submit and blur triggers.
- [x] 1.2 Attach `blur` listeners to `base_url`, `api_key`, and `model` inputs and trigger persistence on blur.
- [x] 1.3 Track last saved normalized settings in popup state so blur only writes when all fields are valid and values changed.
- [x] 1.4 Update popup status messaging for auto-save success and validation-failed skip behavior.

## 2. Validation And Storage Safety

- [x] 2.1 Reuse `saveProviderSettings` for blur-triggered persistence so trimming/required-field validation remains centralized.
- [x] 2.2 Ensure blur-triggered saves do not issue `chrome.storage.sync.set` when normalized values are unchanged.
- [x] 2.3 Preserve existing submit-save behavior as a compatibility path while sharing the same persistence logic.

## 3. Tests And Verification

- [x] 3.1 Add/extend popup behavior tests to cover blur-triggered save on changed valid values.
- [x] 3.2 Add/extend tests to verify blur with missing required fields does not write storage and surfaces validation status.
- [x] 3.3 Add/extend tests to verify blur with unchanged values does not perform redundant storage writes.
- [x] 3.4 Run test suite and confirm no regressions in existing provider-settings and popup-related tests.
