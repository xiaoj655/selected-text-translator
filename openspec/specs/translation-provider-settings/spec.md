# translation-provider-settings Specification

## Purpose
TBD - created by archiving change add-selected-text-translation. Update Purpose after archive.
## Requirements
### Requirement: Store configurable translation provider settings
The extension SHALL provide a settings surface where the user can configure `base_url`, `api_key`, and `model` values used for translation requests.

#### Scenario: User saves provider settings
- **WHEN** the user enters `base_url`, `api_key`, and `model` and saves the form
- **THEN** the extension persists those values for future translation requests

### Requirement: Use stored settings for translation requests
The extension SHALL read the saved provider settings and use them for outgoing translation requests.

#### Scenario: Request uses configured values
- **WHEN** the extension starts a translation request
- **THEN** it uses the currently saved `base_url`, `api_key`, and `model` values to build the request

#### Scenario: Request uses streaming mode
- **WHEN** the extension starts a translation request
- **THEN** it requests a streaming response from the configured model endpoint

### Requirement: Use `qwen-mt` translation options without a system prompt
The extension SHALL treat models in the `qwen-mt` family as a special request path that sends the selected text and `translation_options` only, without a system prompt, and SHALL treat the returned content as the translated text.

#### Scenario: `qwen-mt` request includes translation options
- **WHEN** the configured model is a `qwen-mt` family model and the selected text contains Chinese characters
- **THEN** the extension sends a request with `translation_options.source_lang` set to `auto` and `translation_options.target_lang` set to `English`

#### Scenario: `qwen-mt` request supports non-Chinese target
- **WHEN** the configured model is a `qwen-mt` family model and the selected text contains no Chinese characters
- **THEN** the extension sends a request with `translation_options.source_lang` set to `auto` and `translation_options.target_lang` set to `Chinese`

#### Scenario: `qwen-mt` request omits system prompt
- **WHEN** the configured model is a `qwen-mt` family model
- **THEN** the extension does not include a system prompt in the translation request

#### Scenario: `qwen-mt` response is used as direct translation text
- **WHEN** the configured model is a `qwen-mt` family model and the request succeeds
- **THEN** the extension uses the returned message content directly as the translated text

### Requirement: Use a fixed generic translation prompt for non-`qwen-mt` models
The extension SHALL use a fixed translation prompt as a `system` message for non-`qwen-mt` models and SHALL not apply `qwen-mt`-specific `translation_options` to those requests.

#### Scenario: Non-`qwen-mt` request uses fixed prompt
- **WHEN** the configured model is not in the `qwen-mt` family
- **THEN** the extension sends the fixed generic translation prompt as a `system` message and the selected text as user content

#### Scenario: Non-`qwen-mt` request omits `translation_options`
- **WHEN** the configured model is not in the `qwen-mt` family
- **THEN** the extension does not send `translation_options` in the request

#### Scenario: Non-`qwen-mt` response uses structured JSON
- **WHEN** the configured model is not in the `qwen-mt` family and the request succeeds
- **THEN** the extension expects the returned content to follow the fixed JSON response contract from the prompt

### Requirement: Handle missing configuration gracefully
The extension SHALL not attempt a translation request when required provider settings are missing.

#### Scenario: Missing settings block translation request
- **WHEN** the user hovers the floating trigger and one or more required provider settings are not configured
- **THEN** the extension shows a concise configuration-required state instead of sending a translation request

### Requirement: Bound v1 to a single provider contract
The extension SHALL assume one documented generic contract plus one documented `qwen-mt` specialization for v1 rather than auto-detecting arbitrary provider-specific schemas.

#### Scenario: Unsupported endpoint contract fails clearly
- **WHEN** the configured endpoint does not respond using the expected v1 contract
- **THEN** the extension surfaces a concise error state instead of attempting provider-specific fallback behavior

