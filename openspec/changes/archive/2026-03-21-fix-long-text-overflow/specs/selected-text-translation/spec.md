## MODIFIED Requirements

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

## ADDED Requirements

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
