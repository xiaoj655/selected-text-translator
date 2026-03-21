## MODIFIED Requirements

### Requirement: Validate required popup fields before save
The popup SHALL require non-empty `base_url`, `api_key`, and `model` values after trimming before persisting settings from either manual save submission or blur-triggered auto-save.

#### Scenario: Empty field blocks blur-triggered auto-save
- **WHEN** any required field is empty after trimming when an input loses focus
- **THEN** the popup does not persist settings and shows a concise validation error state

#### Scenario: Empty field blocks manual save
- **WHEN** the user submits the form while one or more required fields are empty after trimming
- **THEN** the popup does not persist settings and shows a concise validation error state

### Requirement: Persist popup settings using the existing provider storage contract
The popup SHALL save provider settings to `chrome.storage.sync` using the same keys consumed by translation requests, and SHALL auto-save on input blur only when normalized values are valid and changed from the last saved values.

#### Scenario: Blur with changed valid values writes storage keys
- **WHEN** an input loses focus and the normalized `base_url`, `api_key`, and `model` values are all non-empty and differ from the last saved values
- **THEN** the extension writes those values to `chrome.storage.sync`

#### Scenario: Blur with unchanged values does not write storage
- **WHEN** an input loses focus and normalized values are unchanged from the last saved values
- **THEN** the popup does not issue a storage write

#### Scenario: Manual save writes storage keys
- **WHEN** the user submits valid popup settings
- **THEN** the extension writes `base_url`, `api_key`, and `model` values to `chrome.storage.sync`

#### Scenario: Saved popup values are used by translation flow
- **WHEN** a translation request starts after popup settings are saved
- **THEN** background request logic reads and uses the saved `base_url`, `api_key`, and `model` values without additional mapping
