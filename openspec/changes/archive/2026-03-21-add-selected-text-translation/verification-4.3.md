## Task 4.3 Manual Verification Checklist

Load unpacked extension from repository root and test on representative normal pages (for example: documentation page, blog article, and news article).

- [ ] Select non-empty body text and confirm green circular trigger appears near selection.
- [ ] Clear selection and confirm trigger + translation card are removed.
- [ ] Hover trigger for <150ms and confirm no request starts.
- [ ] Hover trigger for >=150ms and confirm request starts.
- [ ] Re-hover while request is in-flight and confirm no duplicate request starts.
- [ ] Confirm card prefers right placement when enough space is available.
- [ ] Confirm fallback placement (lower-right, below, or nearest viewport-safe) near viewport edges.
- [ ] Confirm card does not close when clicking trigger.
- [ ] Confirm card does not close when clicking inside card.
- [ ] Confirm card closes when clicking outside card and trigger.
- [ ] With `qwen-mt` model configured, confirm request payload uses `translation_options` and no `system` message.
- [ ] With non-`qwen-mt` model configured, confirm request payload includes fixed `system` prompt and no `translation_options`.
- [ ] Confirm `qwen-mt` stream updates translated text incrementally.
- [ ] Confirm generic-model stream delays visible translation until valid `translation` field is parseable.
- [ ] Configure unsupported endpoint contract and confirm concise in-page error state is shown.
