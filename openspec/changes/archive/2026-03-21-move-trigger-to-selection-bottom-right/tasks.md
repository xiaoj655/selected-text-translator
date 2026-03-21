## 1. Trigger Geometry

- [x] 1.1 Add a focused trigger-anchor calculation that prefers the selection's last non-empty client rect and falls back to the existing bounding rect when needed
- [x] 1.2 Update the floating-trigger preferred position so it appears adjacent to the selection's lower-right corner while keeping the existing viewport clamping behavior
- [x] 1.3 Ensure selection refresh and re-position flows reuse the new trigger geometry without changing card placement or hover-trigger behavior

## 2. Verification

- [x] 2.1 Add or update focused coverage for the lower-right trigger placement logic where the content-script test setup makes geometry validation practical
- [x] 2.2 Verify on representative pages that single-line, multi-line, and viewport-edge selections place the trigger at the lower-right corner or the nearest viewport-safe fallback
