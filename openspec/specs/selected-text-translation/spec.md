# selected-text-translation Specification

## Purpose
TBD - created by archiving change add-selected-text-translation. Update Purpose after archive.
## Requirements
### Requirement: Show a floating trigger for selected text
The extension SHALL detect when a user has an active text selection in normal web page body content and SHALL display a small green circular floating trigger adjacent to the lower-right corner of that selection while keeping the trigger visible within the viewport.

#### Scenario: Trigger appears at the lower-right corner for a valid selection
- **WHEN** the user selects trimmed non-empty text in normal web page body content
- **THEN** the extension shows a green circular trigger adjacent to the selected region's lower-right corner

#### Scenario: Trigger stays viewport-safe near page edges
- **WHEN** the user selects trimmed non-empty text near the right or bottom viewport edge
- **THEN** the extension keeps the floating trigger visible in the nearest viewport-safe position while preserving the lower-right placement preference

#### Scenario: Trigger is removed when selection is cleared
- **WHEN** the active text selection becomes empty
- **THEN** the extension removes the floating trigger and any active translation card

#### Scenario: Unsupported selection contexts do not show trigger
- **WHEN** the selection is outside normal web page body content
- **THEN** the extension does not show the floating trigger

#### Scenario: Trigger remains a plain visual affordance
- **WHEN** the extension renders the floating trigger
- **THEN** it renders as a plain green circular affordance without icons, labels, or extra controls

### Requirement: Start translation from hover
The extension SHALL start a translation request only after the user hovers the floating trigger for a fixed 150ms delay in v1.

#### Scenario: Hover starts translation
- **WHEN** the user keeps the pointer over the floating trigger for at least 150ms
- **THEN** the extension starts a translation request for the current selected text

#### Scenario: Hover shorter than 150ms does not start translation
- **WHEN** the user leaves the floating trigger before 150ms elapses
- **THEN** the extension does not start a translation request

#### Scenario: Hover exit cancels pending trigger
- **WHEN** the user moves the pointer away from the floating trigger before the hover delay completes
- **THEN** the extension does not start a translation request

#### Scenario: Re-hover does not duplicate an in-flight request
- **WHEN** the current selection already has a translation request in progress
- **THEN** the extension does not start a second request for the same selection

### Requirement: Automatically choose Chinese-English translation direction
The extension SHALL determine translation direction from the selected text content by checking whether it contains Chinese characters.

#### Scenario: Chinese-containing text translates to English
- **WHEN** the selected text contains one or more Chinese characters
- **THEN** the extension sets the translation target language to English

#### Scenario: Non-Chinese text translates to Chinese
- **WHEN** the selected text contains no Chinese characters
- **THEN** the extension sets the translation target language to Chinese

### Requirement: Display a nearby translation card without obscuring the selection
The extension SHALL display the translation result in an on-page card positioned near the current selection, preferring the right side, then the lower-right, then below, while avoiding overlap with the selected text whenever possible. The extension SHALL keep the card viewport-visible for long content by constraining card height and allowing internal vertical scrolling when needed.

#### Scenario: Card prefers right-side placement
- **WHEN** there is enough visible space to the right of the selected region
- **THEN** the extension places the translation card to the right of the selection

#### Scenario: Card uses fallback placement
- **WHEN** there is not enough visible space to the right of the selected region
- **THEN** the extension places the translation card in the next available nearby fallback position that keeps it visible and minimizes overlap with the selection

#### Scenario: Card uses viewport-safe fallback when overlap cannot be avoided
- **WHEN** no nearby placement can both keep the card fully visible and fully avoid overlap with the selected region
- **THEN** the extension places the card in the nearest viewport-safe position that keeps the card visible and minimizes overlap with the selection

#### Scenario: Long content uses capped card height with internal scroll
- **WHEN** the source text or translated text would make the translation card taller than the viewport-safe maximum height
- **THEN** the extension constrains the card height to a viewport-safe maximum and allows internal vertical scrolling so all card content remains accessible

### Requirement: Stream translated text into the active card
The extension SHALL request streaming translation output and SHALL update the translated-text region incrementally while the active request is in progress when the response format makes incremental translated text available.

#### Scenario: Card shows partial translated text during stream
- **WHEN** the translation response begins streaming for the active selection
- **THEN** the translation card updates the translated-text region as partial output arrives

#### Scenario: Structured JSON stream waits for usable translation field
- **WHEN** a non-`qwen-mt` model streams structured JSON that does not yet contain a usable `translation` value
- **THEN** the extension may defer visible translated-text updates until it can extract a valid `translation` field

#### Scenario: Superseded selection discards old stream output
- **WHEN** a different selection becomes active while a translation stream is still in progress
- **THEN** the extension ignores any later stream output from the superseded request

### Requirement: Limit card content to source text, translation text, and validated single-word lexical details
The extension SHALL render the selected source text and translated text inside the translation card in the success state. For single-word input, the extension MAY additionally render validated lexical details derived from response fields (`phonetic`, `definitions`, `contextual_analysis`). Loading and error states SHALL remain concise and minimal.

#### Scenario: Sentence or phrase success renders only two text regions
- **WHEN** a translation request succeeds for sentence or phrase input
- **THEN** the translation card shows source text and translated text without lexical detail regions

#### Scenario: Single-word success renders validated lexical details
- **WHEN** a translation request succeeds for single-word input and lexical optional fields are valid
- **THEN** the translation card shows source text, translated text, and available validated lexical details

#### Scenario: Invalid lexical optional fields are ignored
- **WHEN** a translation request succeeds for single-word input but lexical optional fields are missing or invalid
- **THEN** the translation card falls back to showing source text and translated text only

#### Scenario: Loading state stays minimal
- **WHEN** a translation request is in progress
- **THEN** the translation card shows a concise loading state without additional controls, icons, or metadata regions

#### Scenario: Error state stays minimal
- **WHEN** a translation request fails
- **THEN** the translation card shows a concise one-line error state without additional controls, icons, or metadata regions

#### Scenario: New selection replaces prior result
- **WHEN** the user selects different text after a translation card is shown
- **THEN** the extension removes the prior trigger and card and treats the new selection as the only active selection state

#### Scenario: Clicking outside closes the active card
- **WHEN** the user clicks outside the active translation card and outside the floating trigger
- **THEN** the extension closes the current translation card

#### Scenario: Clicking the trigger does not close the active card
- **WHEN** the user clicks the floating trigger for the active selection
- **THEN** the extension keeps the current translation card open

#### Scenario: Clicking inside the card does not close the active card
- **WHEN** the user clicks inside the active translation card
- **THEN** the extension keeps the current translation card open

### Requirement: Emit structured debug lifecycle logs safely
The extension SHALL emit structured debug-level logs for the selection-to-translation lifecycle and SHALL redact sensitive data.

#### Scenario: Lifecycle logs include correlation fields
- **WHEN** selection, hover, request, stream, and completion/error events occur
- **THEN** the extension emits debug log entries with correlation identifiers including `selectionId` and `requestId`

#### Scenario: Logs avoid sensitive credential exposure
- **WHEN** debug logs are emitted during translation handling
- **THEN** the extension never logs `api_key`

#### Scenario: Logs avoid full selected-text exposure
- **WHEN** debug logs include selected text diagnostics
- **THEN** the extension logs only safe diagnostics such as text length and a truncated preview instead of full text content

### Requirement: Allow resizing translation card width by direct drag and persist the result
The extension SHALL allow the user to directly drag the translation card's resize affordance to change card width, SHALL constrain the result within supported bounds, and SHALL persist the final width so later cards use that width by default.

#### Scenario: User drags card edge to resize width
- **WHEN** the user drags the translation card resize affordance horizontally
- **THEN** the card width updates according to drag distance within supported width bounds

#### Scenario: Resized width is persisted and reused
- **WHEN** the user finishes resizing the translation card width
- **THEN** the extension persists the final width and applies it when subsequent translation cards are rendered

#### Scenario: Missing or invalid persisted width falls back to default
- **WHEN** no valid persisted width is available
- **THEN** the extension renders the translation card using the default width
