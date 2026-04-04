# AGENTS.md - Chrome Translate Extension

## Project Overview

This is a Chrome extension (Manifest V3) that provides selected text translation using language models. It consists of:

- **src/content.js**: Content script handling text selection, trigger UI, and translation card rendering
- **src/background.js**: Service worker handling API communication and streaming responses
- **src/translation-contracts.js**: Translation request/response contracts and utilities
- **src/provider-settings.js**: Provider settings management
- **tests/**: Node.js test files using built-in `node:test` runner

## Build/Lint/Test Commands

```bash
# Run all tests
npm test

# Run a single test file
node --test tests/translation-contracts.test.js

# Run a single test (use --test-name-pattern)
node --test --test-name-pattern="getTargetLanguage" tests/translation-contracts.test.js
```

This is a Chrome extension—no build step required. Load the `src/` directory directly via Chrome's developer mode.

## Code Style Guidelines

### General

- No comments in code unless explaining complex logic (per project convention)
- Keep functions focused and small (under ~100 lines preferred)
- Use early returns to reduce nesting

### Imports and Modules

- Use ES modules (`import`/`export`)
- Explicit `.js` extension in import paths: `import { foo } from './foo.js'`
- Use `node:` prefix for Node.js built-ins: `import { readFileSync } from 'node:fs'`
- Group imports: external packages first, then internal modules

### Formatting

- 2-space indentation
- No semicolons at statement ends
- Single quotes for strings
- Trailing commas in multiline object/array literals
- Maximum line length ~120 characters
- No unnecessary whitespace at line ends

### Naming Conventions

- **Constants**: `UPPER_SNAKE_CASE` (e.g., `TRANSLATION_MESSAGE_TYPES`, `STORAGE_KEYS`)
- **Functions/variables**: `camelCase` (e.g., `normalizeProviderSettings`, `debugLog`)
- **Boolean variables**: Prefix with `is`, `has`, `should`, or `can` (e.g., `isQwenMtModel`, `hasContent`)
- **DOM element variables**: Suffix with `El` (e.g., `triggerEl`, `cardEl`)
- **Private module state**: Use closure pattern without `_` prefix convention

### Types and Values

- No TypeScript—plain JavaScript only
- Use `typeof` checks for type narrowing
- `String(value || '')` for string coercion
- `Array.isArray()` for array checks
- `Object.freeze()` for truly constant objects

### Error Handling

- Always use `try/catch` around async operations
- Create specific error messages: `throw new Error('Descriptive message.')`
- Use `normalizeErrorMessage()` pattern to sanitize caught errors
- Empty catch blocks must have `catch { }` (no comment needed)
- Return normalized results rather than throwing for expected error cases

### Logging and Debugging

- Use `debugLog(event, fields)` for structured debug output (JSON object)
- Debug logs guarded by `debugLoggingEnabled` flag
- Use `LOG_PREFIX` constant for log namespace: `'[selected-text-translation]'`
- Never log sensitive data (API keys, full request bodies)
- Use `createSelectedTextDiagnostics()` to sanitize text for logging

### Chrome Extension Patterns

- Message types use `UPPER_SNAKE_CASE` strings: `'START_TRANSLATION'`
- Event statuses use kebab-case: `'started'`, `'stream'`, `'success'`, `'error'`
- Always check `chrome.runtime.lastError` in callback-based APIs
- Use `chrome.storage.sync` for settings persistence
- Content script runs at `document_idle`

### Testing Patterns

- Use `node:test` and `node:assert/strict`
- Import source modules directly: `import { foo } from '../src/foo.js'`
- For source-inspection tests, use `readFileSync(new URL('../src/foo.js', import.meta.url), 'utf8')`
- Use `assert.match()` for regex validation of source code
- Use `assert.deepEqual()` for object/array equality
- Use `assert.equal()` for scalar equality

### Content Script Patterns (content.js)

- Wrap all code in IIFE: `(() => { ... })()` to avoid global pollution
- Use `state` object to hold all module state
- Use `queueMicrotask` for debounced selection scanning
- Event listeners use `capture: true` (third argument) for document-level events
- Use `clamp()` helper for boundary calculations
- DOM creation uses `document.createElement()` + `className` + `appendChild`
- CSS injected via `<style>` element with `style.textContent`
