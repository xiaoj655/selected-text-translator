## 1. Generic Request Contract Update

- [x] 1.1 Update `src/translation-contracts.js` to add `response_format` to non-`qwen-mt` request payloads while keeping `qwen-mt` payload shape unchanged.
- [x] 1.2 Add/adjust helper logic for model-family branching so only non-`qwen-mt` models receive structured-output request parameters.
- [x] 1.3 Ensure request payload logging in `src/background.js` includes the new `response_format` field without exposing sensitive data.

## 2. Prompt And Response Handling Alignment

- [x] 2.1 Replace/optimize the non-`qwen-mt` system prompt in `src/translation-contracts.js` to explicitly require JSON output with required field `translation` and optional lexical fields (`phonetic`, `definitions`, `contextual_analysis`) for single-word input.
- [x] 2.2 Update non-stream response parsing in `src/background.js`/`src/translation-contracts.js` to enforce required-field validation and safely normalize optional lexical fields by schema.
- [x] 2.3 Improve non-`qwen-mt` format-mismatch error messaging/log context so `response_format` incompatibility and invalid field-shape issues are diagnosable.

## 3. Single-Word Lexical Field Rendering

- [x] 3.1 Extend success-event payload shape from background to content script so validated optional lexical fields can be delivered with `translatedText`.
- [x] 3.2 Update `src/content.js` success rendering to show lexical details for single-word input only, while keeping sentence/phrase success view translation-only.
- [x] 3.3 Ensure missing or invalid lexical fields gracefully fall back to translation-only rendering without breaking existing card interactions.

## 4. Tests And Regression Safety

- [x] 4.1 Update `tests/translation-contracts.test.js` to assert non-`qwen-mt` payloads include `response_format` and `qwen-mt` payloads do not.
- [x] 4.2 Add/adjust tests that validate the optimized prompt contract for non-`qwen-mt` requests (JSON-only instruction, required `translation`, and optional lexical field contract).
- [x] 4.3 Add/adjust parsing tests to confirm valid structured JSON is accepted, optional lexical fields are normalized safely, and malformed/missing `translation` responses fail clearly.
- [x] 4.4 Add/adjust content rendering tests for single-word lexical display and sentence/phrase translation-only display.
- [x] 4.5 Run the project test command and confirm no regressions in existing translation and logging-related suites.
