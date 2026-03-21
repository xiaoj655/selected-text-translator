## Context

The repository does not yet contain extension application code, so this change defines the first end-to-end product shape. The extension is intentionally narrow: it is not a page translator and not a multi-tool translation workspace. It exists to translate only the current text selection with as little interaction cost as possible.

The user experience has two surfaces:

- An in-page interaction owned by a content script.
- A small extension configuration surface where users provide `base_url`, `api_key`, and `model`.

Because translation happens from arbitrary web pages, the design needs to keep the injected UI visually self-contained, position it near the active selection, and avoid obscuring the selected text whenever possible.

The implementation should stay lightweight. The product scope does not justify a heavy extension framework or a general-purpose UI component library at this stage.

## Goals / Non-Goals

**Goals:**

- Show a minimal floating trigger only when a meaningful text selection exists.
- Trigger translation on hover with a short debounce to reduce accidental requests.
- Display a compact nearby result card that contains only the source text and translated text in the final success state.
- Enforce an ultra-minimal in-page UI contract: plain green circular trigger and a two-block card, without extra controls.
- Prefer placement to the right of the selection, then lower-right, then another nearby safe area that does not cover the selection.
- Let users configure the translation endpoint through `base_url`, `api_key`, and `model`.
- Automatically translate Chinese-containing text to English, and non-Chinese text to Chinese.
- Stream translation responses so the translated text can appear incrementally in the page.
- Keep the visual language restrained, with a minimal neo-brutalist style: hard edges, strong contrast, and a green circular trigger without icons.
- Keep the implementation stack lightweight and direct so UI and extension behavior remain easy to control.
- Emit structured debug logs across selection, hover, request, and stream lifecycle events for diagnostics.

**Non-Goals:**

- Full-page translation.
- Dark mode or theme variants.
- Rich translation tooling such as copy buttons, language switching, history, glossary, or provider management.
- Visual embellishments such as trigger icons, card toolbars, or metadata panels in v1.
- Automatic adaptation to arbitrary provider-specific request/response schemas.
- Arbitrary per-model prompt editing in the UI.
- Multi-selection workflows or simultaneous translation cards.
- Introducing a heavy extension framework or a large UI component library in v1.

## Decisions

### 1. Use an in-page floating trigger instead of popup-driven translation

The extension will show a small green filled circle near the active selection and keep translation initiation in the page context.

Why:
- This keeps the translation interaction close to the text being read.
- It avoids moving attention to the toolbar popup or context menu for the primary flow.

Alternatives considered:
- Toolbar popup only: simpler structure, but breaks reading flow and weakens the "regional UI" goal.
- Context menu only: reliable fallback, but too hidden for the intended lightweight interaction.

### 2. Trigger translation on hover with a short delay

Hovering the floating trigger will start translation after a short delay rather than immediately on pointer entry.
In v1, this delay is fixed at 150ms.

Why:
- This preserves the smoothness of hover-triggered translation while reducing accidental requests from incidental pointer movement.

Alternatives considered:
- Immediate hover: fastest but noisy and likely to misfire.
- Click to translate: more deliberate, but less fluid than the desired interaction model.

### 3. Keep exactly one active selection UI at a time

The extension will manage only one floating trigger and one result card for the current selection. A new selection replaces the previous UI state, and any older in-flight request result is discarded.

Why:
- This keeps the interaction model legible and avoids stale translation cards scattered across the page.

Alternatives considered:
- Multiple persistent cards: more powerful, but well outside the intended minimal product.

### 4. Use a nearby result card with ordered placement fallbacks

The result card will prefer the selection's right side, then lower-right, then below, then another visible position within the viewport safe area that minimizes overlap with the selected region while keeping the card fully visible if possible.

Why:
- The product requirement is to keep the result spatially tied to the selection without covering it.
- Explicit fallback ordering makes the behavior predictable and testable.

Alternatives considered:
- Fixed viewport corner card: easier positioning, but weaker spatial connection to the selection.
- Always below selection: simpler, but less robust near viewport edges.

### 5. Restrict v1 selection support to normal page body text

The extension will initially support normal text selections in standard web page body content only.

Why:
- This keeps the first version focused and avoids early complexity from editable controls, embedded documents, and browser-owned surfaces.

Alternatives considered:
- Supporting `input`, `textarea`, and `contenteditable` immediately: useful, but expands selection handling and positioning edge cases.
- Supporting iframe and PDF contexts in v1: valuable later, but too broad for the first cut.

### 6. Separate page interaction from translation execution

The content script will own selection detection and injected UI, while a background/service layer will read stored settings and perform network requests.

Why:
- This cleanly separates DOM concerns from remote request concerns.
- It keeps provider credentials and request execution outside the page DOM layer.

Alternatives considered:
- Performing requests directly in the content script: simpler at first, but mixes concerns and complicates extension boundaries.

### 7. Keep the implementation stack lightweight

The extension should use a lightweight TypeScript-based build setup and keep page UI rendering close to the platform rather than introducing a heavy extension framework or a component library.

Why:
- The main complexity is in selection handling, positioning, streaming, and provider branching, not in application-shell UI.
- A small codebase benefits more from direct control than from framework abstraction.
- The in-page UI is too custom and minimal to benefit much from a general component library.

Alternatives considered:
- Heavy extension framework: can speed up scaffolding, but adds opinionated structure without solving the core product challenges.
- Full UI component library: useful for larger apps, but unnecessary for a green circular trigger, a minimal translation card, and a tiny options page.

### 8. Support a single explicit provider contract in v1

Users may configure `base_url`, `api_key`, and `model`, but v1 will support one general chat-completions request path plus one explicit `qwen-mt` specialization rather than trying to auto-adapt to arbitrary provider schemas.

Why:
- The UI requirement is simple; compatibility sprawl would dominate the implementation.
- A bounded set of request shapes keeps configuration understandable and failure modes bounded.

Alternatives considered:
- Generic multi-provider compatibility layer: flexible in theory, but too large for the first version.

### 9. Determine translation direction from Chinese-character detection

The extension will inspect the selected text for Chinese characters. If any Chinese characters are present, the target language becomes English. Otherwise, the target language becomes Chinese.

Why:
- The product is intentionally constrained to Chinese-English translation with no extra language selector.
- A simple deterministic rule is easier to understand and document than full language detection.

Alternatives considered:
- Full language identification: more accurate in edge cases, but unnecessary complexity for this scope.
- Manual language selection: adds controls the user explicitly does not want.

### 10. Stream translation results into the card

The extension will request streaming model output and update the translated-text region incrementally while the response is arriving. For `qwen-mt`, the translated text can stream directly. For non-`qwen-mt` models that return structured JSON, the extension may need to wait until the streamed content yields a valid `translation` value before showing translated text.

Why:
- Streaming lets users perceive progress sooner and improves the feel of a hover-triggered interaction.
- The minimal card can show useful partial output without adding extra controls.
- Different model families can support different degrees of incremental rendering while still fitting the same UI.

Alternatives considered:
- Waiting for the full response before rendering: simpler, but slower and less responsive.

### 11. Use `qwen-mt` as a model-family special case

If the configured model belongs to the `qwen-mt` family, the request will send only the user text plus `extra_body.translation_options`, and will not send a system prompt. The `qwen-mt` response path is expected to provide a direct translation string. Non-`qwen-mt` models will use a fixed system prompt and a generic chat-completions request that returns structured JSON.

Why:
- `qwen-mt` exposes translation-native parameters that should be used directly.
- The user requirement explicitly forbids passing a system prompt to `qwen-mt` models.

Alternatives considered:
- Sending the same prompt-based format to every model: simpler, but incorrect for `qwen-mt`.
- Building a larger model capability registry: more extensible, but too much infrastructure for v1.

### 12. Fix the non-`qwen-mt` prompt contract

For non-`qwen-mt` models, the extension will send a fixed translation prompt as a `system` message:

`You are a professional multilingual translation engine. RULES: For single words: provide translation, phonetics, definitions grouped by part of speech, and example sentences. For sentences/phrases: provide translation only. All responses must be in Simplified Chinese language. For English, Use American phonetics for phonetic symbols. For Chinese, Use standard Pinyin for phonetic symbols (with tone marks) For other languages, use their native phonetic systems for phonetic symbols Do not output languages other than those requested Consider context when analyzing words. Output raw JSON without markdown code blocks. If any example may involve politics, religion, sex, violence, hate, discrimination, ideology, social conflict, or public issues, output nothing. No substitution. No explanation. No expansion. For example, banning saying "Taiwan is a country." SINGLE WORD OUTPUT: { "phonetic": "/həˈləʊ/", "definitions": [ { "pos": "excl.", "meaning": "Simplified Chinese translation for current pos", "example": { "source": "Hello, how are you today?", "target": "Simplified Chinese example" } } ], "translation": "translation in Simplified Chinese", "contextual_analysis": "contextual analysis use Simplified Chinese language" } SENTENCE/PHRASE OUTPUT: { "translation": "translation in Simplified Chinese" }`

Why:
- Fixing the prompt upfront keeps the generic model path deterministic.
- The requested JSON contract belongs specifically to the generic-model path and can be used later by the extension to decide how to display or expand generic-model output.
- Using a `system` message gives the prompt stronger priority than embedding the instructions in the user text.

Alternatives considered:
- Letting the prompt vary by model: more flexible, but introduces configuration and output-shape drift too early.
- Using plain translation-only output for all generic models: simpler, but does not match the requested word-level JSON behavior.
- Embedding the prompt in the `user` message: workable, but weaker and less explicit than a dedicated `system` instruction.

### 13. Enforce radical UI minimalism in all in-page states

The in-page UI will be constrained to a plain green circular trigger and one translation card. In success state, the card contains only source text and translated text. Loading and error states are allowed but remain single-line, concise text states without extra controls.

Why:
- The product goal is zero-friction reading continuity, not feature-rich translation tooling.
- Strict constraints prevent gradual UI creep that would dilute the extension's value proposition.

Alternatives considered:
- Adding lightweight controls (copy, pin, language swap): useful in some workflows, but violates the v1 minimal interaction contract.
- Allowing decorative icons or metadata: can improve affordance, but adds visual noise and complexity.

### 14. Add structured debug lifecycle logs with redaction

The extension will emit debug-level lifecycle events for selection changes, hover start/cancel, request start, stream progress, request completion, and request errors. Logs should include correlation fields such as `selectionId`, `requestId`, `model`, `targetLang`, and `elapsedMs`.

Sensitive data handling is mandatory:
- Never log `api_key`.
- Do not log full selected text by default; only log length and a short truncated preview.

Why:
- Selection and streaming behavior are asynchronous and prone to race conditions; structured logs accelerate diagnosis.
- Correlation IDs are necessary to debug superseded selection and stale-stream suppression behavior.

Alternatives considered:
- No debug logs: less noise, but much harder troubleshooting for hover/stream race bugs.
- Verbose raw payload logging: easier debugging, but unacceptable risk of leaking sensitive content.

## Risks / Trade-offs

- [Hover misfires] -> Add a short hover delay and cancel requests when the pointer leaves before the delay expires.
- [Injected UI conflicts with page layout or styles] -> Use isolated class naming and defensive positioning with high z-index and viewport-aware placement.
- [Selection edge cases across editable fields, rich text, or unusual page structures] -> Define supported selection behavior clearly and test against common DOM selection patterns first.
- [Body-only support may surprise users on editable or embedded surfaces] -> Document v1 support as normal page body text only and treat other contexts as out of scope for now.
- [Frameworks or component libraries could impose unwanted UI patterns] -> Prefer direct implementation and a very small internal styling layer for the trigger, card, and options page.
- [Debug logging could leak sensitive user content or credentials] -> Enforce redaction, never log `api_key`, and limit text logging to safe truncated diagnostics.
- [User confusion when provider settings are missing or invalid] -> Provide a minimal configuration-required state that points users to extension settings without turning the in-page card into a settings surface.
- [Configured endpoints may not match the expected API contract] -> Document the expected contract in settings and fail with a concise, user-readable error state.
- [Generic-model output may return JSON structures that do not match the minimal card UI] -> Treat the JSON `translation` field as the only required display field in v1 and defer richer word rendering to a later change.
- [Different model families return different output shapes] -> Normalize `qwen-mt` plain-text responses and generic-model JSON responses into the same two-block card model before rendering.
- [Generic-model streaming may not yield a usable translation field until late in the response] -> Allow true incremental rendering for `qwen-mt` and best-effort delayed rendering for generic-model JSON streams.
- [Mixed-language selections may be classified as Chinese because they contain any Chinese characters] -> Document this as the intentional v1 rule for Chinese-English toggling.
- [Streaming partial output may be interrupted by selection changes] -> Bind each stream to the active selection identity and ignore chunks from superseded requests.

## Migration Plan

No existing extension behavior needs migration because this is a net-new product surface.

Recommended rollout order:
- Establish extension scaffold and settings persistence.
- Implement selection tracking and floating trigger rendering.
- Add result card positioning and translation request flow.
- Validate behavior across a small matrix of common websites before broadening scope.

## Open Questions

- Should there be a secondary fallback trigger such as a context menu item from the first release, or can it wait?
- For non-`qwen-mt` models, should invalid or non-JSON responses be shown as a generic error or should a best-effort translation extraction be attempted?
