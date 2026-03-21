## Why

The extension currently requires users to open a separate options page before they can configure provider credentials. A toolbar popup with the same core fields makes first-time setup and quick edits much faster while keeping the translation workflow lightweight.

## What Changes

- Add a compact action popup that opens when users click the extension icon.
- Include `base_url`, `api_key`, and `model` fields in the popup, with save behavior consistent with existing settings storage.
- Keep popup validation minimal and require all three fields before saving.
- Keep storage keys and request behavior unchanged so translation logic continues using the same persisted settings.
- Preserve the existing options page as a secondary configuration surface unless explicitly removed in a later change.

## Capabilities

### New Capabilities
- `action-popup-provider-settings`: Provide a click-to-open extension popup that allows users to view and save `base_url`, `api_key`, and `model` settings.

### Modified Capabilities
None.

## Impact

- Manifest action configuration will add a popup entry.
- New popup UI files (HTML/CSS/JS) and associated settings form handling.
- Shared settings persistence contract in `chrome.storage.sync` remains the source of truth.
- Existing background translation request flow continues to consume the same `base_url`, `api_key`, and `model` values.
