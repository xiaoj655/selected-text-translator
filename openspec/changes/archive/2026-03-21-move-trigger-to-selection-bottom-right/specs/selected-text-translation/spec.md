## MODIFIED Requirements

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
