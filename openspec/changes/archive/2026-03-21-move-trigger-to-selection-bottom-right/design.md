## Context

The current selected-text trigger placement in `src/content.js` uses the selection bounding rectangle's right edge plus a horizontal gap, but it aligns vertically near the selection's top edge. That makes the hover target feel detached from the point where the user's attention usually lands after finishing a selection.

This change is intentionally narrow. It does not alter how translation starts, how cards are positioned, or how selection lifecycle state works. The goal is to tighten the trigger's geometry so the affordance appears at the lower-right side of the selected text while keeping the existing viewport-safe behavior.

## Goals / Non-Goals

**Goals:**

- Move the floating trigger so it appears adjacent to the lower-right corner of the current selection.
- Keep the trigger visible when the selection is close to the viewport edges.
- Improve placement quality for both single-line and multi-line selections without changing the broader translation flow.
- Keep the change localized to content-script selection geometry and related verification.

**Non-Goals:**

- Redesigning the trigger visual style, size, or hover timing.
- Changing translation-card placement or any background request behavior.
- Expanding selection support to new contexts such as editable fields or embedded documents.

## Decisions

### 1. Use a dedicated lower-right anchor for the trigger

The trigger should no longer derive its vertical position from the selection's top edge. Instead, it should anchor to the selection's lower-right corner with a small visual offset so the affordance sits adjacent to, not on top of, the selected text.

Why:
- The lower-right corner better matches the user's likely pointer destination after a drag selection.
- A small offset preserves readability by avoiding overlap with the highlighted text.

Alternatives considered:
- Reusing the current upper-right placement and only reducing the offset: still leaves the hover target too high for the intended interaction.
- Placing the trigger directly on top of the selection corner: keeps it visually closer, but risks covering text and highlight color.

### 2. Prefer the last visible client rect when available

For multi-line selections, the trigger anchor should use the last non-empty client rect from the range when available, with fallback to the existing bounding rect. This keeps the trigger close to the visual end of the selected text instead of the union rectangle's top/right extremes.

Why:
- Multi-line selections are where upper-edge placement feels worst.
- The last visible client rect better represents the user's perceived endpoint than the overall bounding box.

Alternatives considered:
- Using only `range.getBoundingClientRect()`: simpler, but can place the trigger far from the actual end of a wrapped selection.
- Tracking selection direction to infer a visual endpoint: more complex than necessary for this UX refinement.

### 3. Keep existing viewport clamping semantics

The trigger should continue using viewport-safe clamping so it remains visible when the selection is close to the right or bottom edges of the page. The new lower-right anchor should be treated as the preferred position, with clamping applied afterward.

Why:
- The change is about preferred geometry, not about relaxing visibility guarantees.
- Retaining the current clamp behavior keeps the implementation low-risk and predictable.

Alternatives considered:
- Allowing the trigger to overflow the viewport near edges: unacceptable because it creates an unreachable hover target.
- Introducing a more complex ordered fallback matrix: unnecessary for a single trigger affordance.

## Risks / Trade-offs

- [Last-line geometry can be inconsistent on unusual page layouts] -> Fall back to the existing bounding rect when client rect data is missing or empty.
- [Bottom-right placement may feel slightly farther away for very short selections near the viewport bottom] -> Clamp inside the viewport while keeping the trigger as close as possible to the preferred lower-right anchor.
- [Small geometry tweaks can regress established behavior silently] -> Add explicit verification for single-line, multi-line, and viewport-edge selections.
