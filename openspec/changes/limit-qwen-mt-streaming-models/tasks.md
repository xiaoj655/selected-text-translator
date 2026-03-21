## 1. Request Contract Updates

- [x] 1.1 Add a model-capability helper in `src/translation-contracts.js` to identify stream-capable `qwen-mt` models (`qwen-mt-flash`, `qwen-mt-lite`) using normalized model names.
- [x] 1.2 Update `buildQwenMtRequest` to set `stream` based on the stream-capability helper while preserving existing `translation_options` and no-system-prompt behavior.
- [x] 1.3 Keep non-`qwen-mt` request construction unchanged and verify branch logic still routes non-`qwen-mt` models to structured-output requests.

## 2. Background Response Handling

- [x] 2.1 Update `src/background.js` request-mode selection so `qwen-mt` requests can use either streaming or non-streaming consumption paths based on request payload.
- [x] 2.2 Implement/adjust non-stream `qwen-mt` response parsing to extract final translated text safely from successful responses.
- [x] 2.3 Ensure event emission semantics stay consistent: emit `STREAM` only for streaming requests, and emit `SUCCESS` with final translation for both streaming and non-streaming paths.

## 3. Content-Side Compatibility Checks

- [x] 3.1 Verify `src/content.js` correctly renders incremental updates only when `STREAM` events are received.
- [x] 3.2 Verify non-streaming success flow still renders translated text and lexical payload handling without requiring any `STREAM` event.

## 4. Tests And Verification

- [x] 4.1 Extend `tests/translation-contracts.test.js` with coverage for stream-capable whitelist matching and non-whitelist `qwen-mt` stream disabling.
- [x] 4.2 Add/update background translation tests to cover both `qwen-mt` streaming and non-streaming success paths, including error behavior for malformed responses.
- [x] 4.3 Run the test suite and confirm no regressions in existing `qwen-mt` and non-`qwen-mt` request contracts.
