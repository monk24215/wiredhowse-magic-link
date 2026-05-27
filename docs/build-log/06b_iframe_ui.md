# Chunk 6b: Iframe UI bundle

**Status:** ✅ Complete
**Model:** Opus 4.7 (iframe + postMessage boundary per model policy)
**Spec references:** `spec/04_snippet_api.md`

## Prompt sent to Claude Code

(Excerpt from chunk 6 intro prompt)

> 6b: Iframe UI bundle
>   - Email entry form
>   - "Check your email" state
>   - Error states (rate limited, site disabled, network error)
>   - postMessage protocol: wh:ready, wh:size, wh:dismiss, wh:options
>   - Strict origin checks on both sides of the postMessage channel
>   - Minimal styling, no framework dependencies, accessible

## Deliverable summary

### `packages/snippet/src/iframe.ts` — parent-side overlay manager

- Fixed-position overlay: wrapper div → backdrop (click-to-dismiss) → iframe
- postMessage protocol:
  - `wh:ready` (iframe → parent) → parent sends `wh:options` back
  - `wh:size` (iframe → parent) → parent resizes iframe
  - `wh:dismiss` (iframe → parent) → parent resolves promise, cleans up
- **Security: double-checked** with `event.origin === iframeOrigin` AND `event.source === iframe.contentWindow`.
- `wh:options` sent with `targetOrigin = iframeOrigin` (never `'*'`).
- Settled-guard prevents double-resolution on concurrent dismiss signals.

### `packages/snippet/src/ui/index.ts` — iframe UI bundle

- State machine: `email-entry → loading → sent | error`
- All DOM built via `createElement`/`textContent` — **no `innerHTML` for user data** (XSS-safe by construction)
- postMessage:
  - `wh:ready` on boot
  - `wh:size` on every render (via `requestAnimationFrame`)
  - `wh:dismiss` on X/close
  - Accepts `wh:options` from parent
- **Security: incoming `wh:options` checked** with `event.source === window.parent`
- API call: `POST /v1/snippet/magic-link/request` with `X-Site-Key`, `credentials: 'omit'`
- Error kinds: `rate_limited | site_disabled | network_error | generic` — each with user-friendly copy
- Accessible: `aria-required`, `role="alert"`, `aria-label`, focus management

## Files

- `packages/snippet/src/iframe.ts` (replaces stub)
- `packages/snippet/src/ui/index.ts` (replaces stub)
- `packages/snippet/src/iframe.test.ts`
- `packages/snippet/src/ui/index.test.ts`

## Tests

- 33 tests for parent-side iframe: DOM structure, all postMessage message types, origin filtering, backdrop click, position variants, error handling.
- 26 tests for iframe UI: boot, form, close button, validation, success/error API flows, sent-state retry, `wh:options`, `wh:size`.
- **99/99 tests passing.** 0 TypeScript errors.

## Notable

- **Bundle size: 3.16 KiB gzipped** vs 15 KiB spec budget. Five times under budget. Significant runway for future features without bundle-splitting.
- **Double-origin check on postMessage** (`event.origin` AND `event.source`) is the textbook-correct pattern. Most production code in the wild only checks `event.origin`.
- **`createElement` + `textContent`, never `innerHTML`** eliminates the XSS class for the iframe UI by construction. Even if a future change accidentally passes user input into DOM, it can't execute as script.
- **`targetOrigin` always explicit, never `'*'`** — prevents iframe contents from leaking to whatever happens to be embedding us if origin checks ever regress.

## Review notes

The surface I worried about most after the auth endpoints. Done right. Opus 4.7 earned its slot here — the security properties are subtle and the test coverage proves them.

## Next chunk

6c: Static serving + integration with api. Routes for `/v1/snippet.js`, `/v1/snippet-ui.js`, `/v1/snippet/ui`, `/v1/snippet.d.ts`. Bundle-size CI guard. Closes chunk 6.
