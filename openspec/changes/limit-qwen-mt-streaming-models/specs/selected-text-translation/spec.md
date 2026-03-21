## MODIFIED Requirements

### Requirement: Stream translated text into the active card
The extension SHALL update the translated-text region incrementally while a stream-enabled translation request is in progress, and SHALL render the final translated text on success for non-streaming requests.

#### Scenario: Card shows partial translated text during stream
- **WHEN** the active translation request uses streaming mode and stream chunks are received
- **THEN** the translation card updates the translated-text region as partial output arrives

#### Scenario: Non-streaming request renders translation at completion
- **WHEN** the active translation request does not use streaming mode and returns success
- **THEN** the translation card renders the translated-text region from the final success payload

#### Scenario: Superseded selection discards old stream output
- **WHEN** a different selection becomes active while a translation stream is still in progress
- **THEN** the extension ignores any later stream output from the superseded request
