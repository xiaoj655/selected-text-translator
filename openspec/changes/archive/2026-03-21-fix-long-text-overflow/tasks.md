## 1. Card Overflow Safety

- [x] 1.1 Update injected translation-card styles in `src/content.js` to enforce a viewport-safe `max-height`.
- [x] 1.2 Add vertical overflow behavior for long card content and prevent horizontal overflow regression.
- [x] 1.3 Ensure loading/status/result card states all respect the same height-safety constraints.

## 2. Drag Resize And Persistence

- [x] 2.1 Add a resize affordance on the translation result card and implement pointer-based horizontal drag resizing.
- [x] 2.2 Clamp resized width to supported min/max bounds and apply the effective width during layout and positioning.
- [x] 2.3 Persist the final resized width on drag end and load it as the default width for subsequent cards.

## 3. Positioning Compatibility

- [x] 3.1 Ensure card positioning logic uses the effective width (default or persisted) while preserving existing placement priority and overlap minimization.
- [x] 3.2 Verify resizing does not break viewport-safe placement near page edges.
- [x] 3.3 Confirm streaming updates keep card layout stable without overflow jumps.

## 4. Tests And Verification

- [x] 4.1 Add or update tests for long translation content to assert capped card height and internal scroll availability.
- [x] 4.2 Add or update tests for drag-based width resizing, bounds clamping, and persisted-width reuse.
- [x] 4.3 Add or update placement tests for resized widths to confirm viewport-safe behavior remains correct.
