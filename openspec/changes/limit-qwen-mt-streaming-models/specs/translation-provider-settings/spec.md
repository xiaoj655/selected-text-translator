## MODIFIED Requirements

### Requirement: Use stored settings for translation requests
The extension SHALL read the saved provider settings and use them for outgoing translation requests. The extension SHALL enable streaming only for stream-capable models (`qwen-mt-flash`, `qwen-mt-lite`) and SHALL disable streaming for all other models, including other `qwen-mt*` variants.

#### Scenario: Request uses configured values
- **WHEN** the extension starts a translation request
- **THEN** it uses the currently saved `base_url`, `api_key`, and `model` values to build the request

#### Scenario: Request uses streaming mode for stream-capable `qwen-mt` models
- **WHEN** the configured model is `qwen-mt-flash` or `qwen-mt-lite`
- **THEN** the extension requests a streaming response from the endpoint

#### Scenario: Request disables streaming mode for non-stream-capable `qwen-mt` models
- **WHEN** the configured model starts with `qwen-mt` but is not `qwen-mt-flash` or `qwen-mt-lite`
- **THEN** the extension sends the request without streaming mode enabled

### Requirement: Use `qwen-mt` translation options without a system prompt
The extension SHALL treat models in the `qwen-mt` family as a special request path that sends the selected text and `translation_options` only, without a system prompt, and SHALL treat the returned content as the translated text for both streaming and non-streaming `qwen-mt` requests.

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
