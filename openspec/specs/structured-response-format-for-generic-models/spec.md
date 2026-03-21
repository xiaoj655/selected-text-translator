# structured-response-format-for-generic-models Specification

## Purpose
TBD - created by archiving change add-response-format-for-non-qwen-mt-models. Update Purpose after archive.
## Requirements
### Requirement: Apply `response_format` to non-`qwen-mt` translation requests
The extension SHALL include a `response_format` object when building chat-completions translation requests for models that are not in the `qwen-mt` family.

#### Scenario: Non-`qwen-mt` request sets `json_object` mode
- **WHEN** the configured model is not in the `qwen-mt` family and the extension starts a translation request
- **THEN** the request body includes `response_format` with `type` set to `json_object`

#### Scenario: `qwen-mt` request keeps dedicated contract
- **WHEN** the configured model is in the `qwen-mt` family
- **THEN** the request body does not include `response_format` and continues using `translation_options`

### Requirement: Keep non-`qwen-mt` prompt aligned with structured-output mode
The extension SHALL use a non-`qwen-mt` system prompt that explicitly requires a valid JSON object with a top-level `translation` string when `response_format.type` is `json_object`.

#### Scenario: Prompt explicitly requests JSON output
- **WHEN** the extension builds a non-`qwen-mt` request with `response_format.type` equal to `json_object`
- **THEN** the system prompt explicitly instructs the model to return JSON only, without markdown code fences or explanatory text

#### Scenario: Generic response is consumed from `translation` field
- **WHEN** a non-`qwen-mt` request succeeds with JSON content in `choices[0].message.content`
- **THEN** the extension extracts the `translation` string and uses it as the translated text

### Requirement: Enforce response field contract and safe field usage
The extension SHALL treat `translation` as the only required response field for non-`qwen-mt` models, and SHALL only consume optional lexical fields when they pass validation and match single-word usage.

#### Scenario: Required field missing fails clearly
- **WHEN** non-`qwen-mt` JSON content does not contain a non-empty string `translation`
- **THEN** the extension treats the response as invalid and surfaces a concise format error

#### Scenario: Single-word input may consume lexical optional fields
- **WHEN** the selected input is a single word and non-`qwen-mt` JSON content includes valid `phonetic`, `definitions`, or `contextual_analysis`
- **THEN** the extension may consume those optional fields in addition to `translation`

#### Scenario: Non-single-word input ignores lexical optional fields
- **WHEN** the selected input is a sentence or phrase and non-`qwen-mt` JSON content includes lexical optional fields
- **THEN** the extension ignores those lexical fields and uses `translation` only

#### Scenario: Invalid optional field structure is ignored
- **WHEN** optional lexical fields are present but fail schema validation (for example malformed `definitions` items)
- **THEN** the extension ignores invalid optional fields and continues with valid fields without failing the whole success response
