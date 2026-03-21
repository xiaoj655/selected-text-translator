## MODIFIED Requirements

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
