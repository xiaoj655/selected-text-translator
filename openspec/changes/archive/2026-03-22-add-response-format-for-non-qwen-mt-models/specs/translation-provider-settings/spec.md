## MODIFIED Requirements

### Requirement: Use a fixed generic translation prompt for non-`qwen-mt` models
The extension SHALL use a fixed translation prompt as a `system` message for non-`qwen-mt` models, SHALL set `response_format` for structured-output mode, and SHALL not apply `qwen-mt`-specific `translation_options` to those requests.

#### Scenario: Non-`qwen-mt` request uses fixed prompt
- **WHEN** the configured model is not in the `qwen-mt` family
- **THEN** the extension sends the fixed generic translation prompt as a `system` message and the selected text as user content

#### Scenario: Non-`qwen-mt` request sets `response_format`
- **WHEN** the configured model is not in the `qwen-mt` family
- **THEN** the extension sends a `response_format` object with `type` set to `json_object`

#### Scenario: Non-`qwen-mt` prompt explicitly requires JSON
- **WHEN** the extension sends a non-`qwen-mt` request with `response_format.type` set to `json_object`
- **THEN** the prompt explicitly instructs the model to output valid JSON and not output markdown wrappers or extra prose

#### Scenario: Non-`qwen-mt` request omits `translation_options`
- **WHEN** the configured model is not in the `qwen-mt` family
- **THEN** the extension does not send `translation_options` in the request

#### Scenario: Non-`qwen-mt` response uses structured JSON
- **WHEN** the configured model is not in the `qwen-mt` family and the request succeeds
- **THEN** the extension expects the returned content to include a valid `translation` string and may include lexical optional fields (`phonetic`, `definitions`, `contextual_analysis`) according to the fixed JSON response contract
