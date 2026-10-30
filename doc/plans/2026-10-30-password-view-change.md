# Password VIEW_CHANGE implementation plan

> **For agentic workers:** Implement inline with test-driven development; verify the full suite and compiled demo before completion.

**Goal:** Keep password input `VIEW_CHANGE` events without ever reading or reporting their `textValue`, including when track is enabled. Explicit sensitive/ignore still rejects the event.

**Architecture:** Separate the compiler's password value-redaction marker from event sensitivity. The normalizer enforces redaction before reading input values or text metadata; only normalized protocol fields reach dispatch and upload.

**Tech Stack:** TypeScript, Vue SFC compiler, Vitest, traditional uni-app Vue 3.

**Spec:** The user's 2026-10-30 request in this chat; update the existing autotrack design and protocol documentation to match.

## Global constraints

- Static password / safe-password and dynamic password bindings retain completion events, never values. Dynamic password bindings stay conservatively redacted in every state without re-evaluating bindings.
- Explicit sensitive / ignore and file or unprovable dynamic input types keep rejecting events.
- Password recognition must work with compiler metadata and currentTarget / target host metadata. Track and title cannot restore a password value.
- Keep business callbacks, completion selection, production capabilities and public wire fields intact.

## Review focus

- Password markers must not replace an explicit sensitive marker.
- Password detail, target value and title getters must not be accessed.
- Both native targets and attr-based wrappers must enforce redaction.
- A masked/unmasked dynamic password binding must never start reading values.
- Queues, collector payloads and debug output must omit password values.

## Task 1: Compiler and runtime privacy rule

- [x] Add failing normalizer, compiled-SFC and real-demo regression tests for retained password events, forbidden reads and sensitive precedence.
- [x] Run the focused tests and verify failures are missing password events.
- [x] Add an internal `redactValue` probe marker; keep sensitive and file/dynamic-type exclusion separate.
- [x] Update existing App/Mini Program pipeline expectations and verify protocol events omit `textValue`.
- [x] Update demo labels and current behavior documentation; preserve historical device results with a dated clarification.
- [x] Run typecheck, full tests/coverage, SDK/demo and App/Harmony compilation checks; review the diff.

## Verification

- The initial 14 targeted cases failed on missing password events; all 15 final targeted cases pass.
- Final review `pnpm run test:release`: 87 files / 1,901 tests pass, including per-file coverage thresholds.
- SDK build, compiled consumer types and demo structure pass; four HBuilderX App package builds and eight WeChat Mini Program builds pass.
- The actual demo compiles to Harmony `app-service.js` with password redaction and explicit sensitive markers preserved. The temporary CLI fixture declares the installed Harmony platform dependency so this is a platform build rather than a plain Vite build.
- Independent read-only review found an early App PAGE title regression: a title update received while waiting for App show was overwritten by the pending show snapshot. The pending title now follows updates for its matching page instance; six new Android/iOS/HarmonyOS ready/hydrating regressions failed before the fix and pass afterward, including isolation from another page's title update. No actionable issues remain after re-review.
- No real-device retest or production capability change is claimed.
