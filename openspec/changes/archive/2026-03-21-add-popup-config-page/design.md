## Context

The extension already has a full options page (`src/options.html`) that stores provider settings in `chrome.storage.sync` using `base_url`, `api_key`, and `model`. Translation requests in the background service worker already depend on those exact storage keys.

The new requirement is to let users configure these three values directly from the extension action click flow, without navigating to a separate options page. This introduces an additional configuration surface and creates a consistency risk if popup and options settings logic diverge.

Constraints:
- Must remain compatible with Manifest V3 action popup behavior.
- Must keep existing storage keys unchanged so background translation flow keeps working.
- Should avoid adding unnecessary permissions or external dependencies.

## Goals / Non-Goals

**Goals:**
- Add a compact popup that opens when users click the extension icon.
- Let users view and save `base_url`, `api_key`, and `model` from the popup.
- Keep validation behavior clear and minimal (all three fields required).
- Keep popup and existing options page consistent by sharing provider-settings persistence logic.
- Preserve current translation request behavior by reusing the same storage contract.

**Non-Goals:**
- Redesigning the in-page translation interaction.
- Changing provider request payload formats or model branching behavior.
- Moving all options-page controls into popup, such as the debug logging toggle.
- Introducing account systems, encryption layers, or multi-provider profile management.

## Decisions

### 1. Add an action popup entry in the manifest
Set `manifest.action.default_popup` to a new popup page so clicking the extension icon opens a small settings UI immediately.

Why:
- This directly satisfies the requested interaction model.
- It keeps setup and quick edits one click away from any tab.

Alternatives considered:
- Keep action click without popup and navigate users to options: slower and adds context switching.
- Add a context-menu-only settings entry: weaker discoverability than action click.

### 2. Keep popup scope to three required provider fields
The popup will include only `base_url`, `api_key`, and `model`, plus save feedback.

Why:
- It matches the requested scope exactly.
- It keeps popup size and interaction cost low.

Alternatives considered:
- Mirror the full options page in the popup: adds clutter and makes the constrained surface harder to scan.

### 3. Share provider settings persistence between popup and options
Introduce a small shared module for reading, validating, and saving `base_url`, `api_key`, and `model`, and use it from both popup and options scripts.

Why:
- It prevents the two settings surfaces from drifting in validation or storage behavior.
- It keeps the source of truth in one place while preserving the existing storage contract.

Alternatives considered:
- Duplicate save and load logic in the popup: faster to ship initially, but increases maintenance risk immediately.

### 4. Keep the existing options page as a secondary surface
The options page remains available for compatibility and for controls that do not belong in the popup.

Why:
- It avoids breaking current workflows.
- It lets the popup stay focused on the three provider fields while advanced settings remain elsewhere.

Alternatives considered:
- Replace the options page entirely: unnecessary migration risk for a scoped change.

## Risks / Trade-offs

- [Popup and options behavior diverge over time] -> Centralize provider settings helpers and have both surfaces reuse them.
- [Popup lifecycle is short and users may close it before feedback is visible] -> Show immediate inline save and validation status.
- [Users expect debug controls in the popup] -> Keep the popup intentionally minimal and leave advanced controls in the options page.
- [Basic required-field checks may still allow malformed endpoints] -> Keep popup validation lightweight in v1 and rely on request-time error handling for endpoint-specific failures.

## Migration Plan

- Add popup assets and wire them through `manifest.action.default_popup`.
- Reuse the existing `base_url`, `api_key`, and `model` storage keys with no data migration.
- Keep the current options page intact so existing flows continue to work.
- Rollback is low-risk: remove popup wiring and files while preserving the unchanged storage contract.

## Open Questions

- Should the popup include a shortcut to open the full options page for advanced settings later?
- Should `base_url` validation remain non-empty only, or be tightened to require `http`/`https` in a follow-up change?
