## ADDED Requirements

### Requirement: Open provider settings popup from extension action click
The extension SHALL open a compact provider-settings popup when the user clicks the extension toolbar icon.

#### Scenario: Action click opens popup UI
- **WHEN** the user clicks the extension action icon
- **THEN** Chrome opens the extension popup surface containing the provider settings form

### Requirement: Show provider fields in the popup
The popup SHALL provide editable fields for `base_url`, `api_key`, and `model`.

#### Scenario: Popup renders required fields
- **WHEN** the popup is displayed
- **THEN** it shows input controls for `base_url`, `api_key`, and `model`

#### Scenario: Popup loads previously saved settings
- **WHEN** the popup is displayed and values already exist in `chrome.storage.sync`
- **THEN** the popup pre-fills `base_url`, `api_key`, and `model` with the saved values

### Requirement: Validate required popup fields before save
The popup SHALL require non-empty `base_url`, `api_key`, and `model` values before persisting settings.

#### Scenario: Empty field blocks save
- **WHEN** the user attempts to save while one or more required fields are empty after trimming
- **THEN** the popup does not persist settings and shows a validation error state

### Requirement: Persist popup settings using the existing provider storage contract
The popup SHALL save provider settings to `chrome.storage.sync` using the same keys consumed by translation requests.

#### Scenario: Successful save writes storage keys
- **WHEN** the user saves valid popup settings
- **THEN** the extension writes `base_url`, `api_key`, and `model` values to `chrome.storage.sync`

#### Scenario: Saved popup values are used by translation flow
- **WHEN** a translation request starts after popup settings are saved
- **THEN** background request logic reads and uses the saved `base_url`, `api_key`, and `model` values without additional mapping

### Requirement: Keep options page compatibility with popup-saved values
The extension SHALL keep the existing options-page settings surface compatible with popup writes by using the same provider settings contract.

#### Scenario: Options page reflects popup-saved values
- **WHEN** the user saves provider settings in the popup and later opens the options page
- **THEN** the options page loads the same saved values for `base_url`, `api_key`, and `model`
