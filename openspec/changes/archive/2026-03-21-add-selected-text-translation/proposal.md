## Why

This extension is meant to provide a lightweight selected-text translation experience inside Chrome pages without the weight of full-page translation. The value is in keeping the user in reading flow: a minimal affordance near the current selection, a translation result that stays close to the text, and no unnecessary controls or visual noise.

## What Changes

- Add a Chrome extension flow that detects selected page text and shows a small green circular trigger near the selection.
- Trigger translation when the user hovers the floating trigger, rather than requiring a click.
- Render a compact on-page result card near the selection, preferring placement to the right or lower-right while avoiding covering the selected text.
- Limit the result card content to the original text and translated text only.
- Keep the in-page UI radically minimal: a plain green circular trigger plus a two-block translation card, with no extra controls.
- Add extension settings for user-supplied `base_url`, `api_key`, and `model`.
- Route translation requests through the configured provider settings instead of hard-coding a vendor integration.
- Detect whether the selected text contains Chinese characters and automatically translate between Chinese and English.
- Add special request handling for `qwen-mt` models so they use `translation_options` without a system prompt, while non-`qwen-mt` models use a fixed translation prompt.
- Add structured debug lifecycle logs for selection, hover, request, and streaming states, with sensitive data redaction.

## Capabilities

### New Capabilities
- `selected-text-translation`: Translate user-selected text from a floating in-page trigger and show the result in a compact nearby card.
- `translation-provider-settings`: Allow users to configure the remote translation service endpoint and model credentials used by the extension.

### Modified Capabilities

None.

## Impact

- New Chrome extension surfaces: content script, background/service worker, and options page.
- New in-page UI and positioning logic for the floating trigger and result card.
- New persistence of user settings in extension storage.
- New outbound translation requests to a user-configured remote service.
- Conditional request formatting based on model family, including a `qwen-mt` path and a general LLM path.
