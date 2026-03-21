## 1. Extension Foundation

- [x] 1.1 Create the Chrome extension scaffold with manifest, content script, background/service worker, and options page entry points
- [x] 1.2 Add extension storage support for persisted `base_url`, `api_key`, and `model` settings
- [x] 1.3 Define the v1 translation request contracts for generic chat-completions models and `qwen-mt` models

## 2. In-Page Translation Interaction

- [x] 2.1 Implement selected-text detection and lifecycle management for a single active selection
- [x] 2.2 Implement the green circular floating trigger and fixed 150ms hover-delay behavior for starting translation
- [x] 2.3 Implement viewport-aware positioning logic that prefers right-side placement and avoids covering the selected text
- [x] 2.4 Implement the minimal translation card that renders only source text and translated text in success state, plus minimal transient loading/error states
- [x] 2.5 Enforce ultra-minimal UI constraints (plain trigger without icon/label and no extra controls/metadata in card states)

## 3. Translation Request Flow

- [x] 3.1 Implement background-side streaming translation requests using stored provider settings and automatic Chinese-English direction detection
- [x] 3.2 Implement content/background messaging for request start, success, missing-configuration, and error states
- [x] 3.3 Implement model-family branching so `qwen-mt` requests send only selected text plus `translation_options`, while non-`qwen-mt` requests use the fixed translation prompt
- [x] 3.4 Stream partial translated output into the active card for `qwen-mt`, and support delayed translation rendering for generic-model JSON streams until a valid `translation` field is available
- [x] 3.5 Normalize `qwen-mt` plain-text responses and generic-model JSON responses into the minimal two-block card UI
- [x] 3.6 Ensure a new selection replaces prior trigger, pending hover state, and active translation card
- [x] 3.7 Add structured debug logs for selection, hover, request start, stream progress, success, and error lifecycle events
- [x] 3.8 Enforce debug-log safety rules: never log `api_key`, and log selected text only as length plus truncated preview

## 4. Settings and Validation

- [x] 4.1 Build the options page form for `base_url`, `api_key`, and `model`
- [x] 4.2 Validate required settings before translation and show a concise configuration-required state in-page
- [x] 4.3 Verify behavior on representative normal web pages for selection handling, fixed 150ms hover-delay trigger threshold, placement fallbacks, click-outside closing rules, streaming updates, `qwen-mt` request formatting, and unsupported endpoint responses
- [x] 4.4 Verify debug logs contain correlation IDs (`selectionId`, `requestId`) and follow redaction rules under success/error paths
