# Chunk 6a: Snippet core (storage, API, events)

**Status:** ✅ Complete (deliverable summary not captured at the time)
**Model:** Sonnet 4.6
**Spec references:** `spec/04_snippet_api.md`

## Prompt sent to Claude Code

(Excerpt from chunk 6 intro prompt)

> 6a: Core snippet structure
>   - esbuild config producing the two bundles
>   - window.wiredhowseAuth API: getSession, requireSession, signOut, on, off
>   - Async queue pattern (window.wiredhowseAuth.q.push(...) before script loads)
>   - Storage layer (localStorage → sessionStorage fallback, per-site key)
>   - API client (fetch wrapper with X-Site-Key header, Bearer auth, Origin handling)
>   - Event emitter
>   - Initial session check on load (data-mode="auto") vs deferred (data-mode="manual")
>   - Fragment handoff consumption: read window.location.hash for #wh_handoff=..., exchange, store, history.replaceState to clear

## Deliverable summary

*Captured retroactively from references in chunk 6b's deliverable and the surrounding code.*

Built the core snippet runtime in `packages/snippet/src/`:

- **esbuild config** producing two browser bundles: `snippet.js` (main, customer-embedded) and `snippet-ui.js` (iframe contents).
- **`window.wiredhowseAuth` API** — public surface per `spec/04`. Methods: `getSession`, `requireSession`, `signOut`, `on`, `off`.
- **Async queue replay** — supports the `window.wiredhowseAuth = window.wiredhowseAuth || { q: [] }` pre-load pattern. Queued calls replay after init.
- **Storage layer** — localStorage primary, sessionStorage fallback, per-site key (`wh_session_<site_id>`) for collision-free multi-site browsers.
- **API client** — fetch wrapper sending `X-Site-Key`, `Origin`, optional `Authorization: Bearer <token>`. Single source of HTTP truth.
- **Event emitter** — typed events: `session`, `signout`, `site_disabled`, `error`, `ready`.
- **Auto vs manual mode** — `data-mode="auto"` (default) checks session on load and renders iframe if needed; `data-mode="manual"` defers to host code's `requireSession()` call.
- **Fragment handoff consumption** — on load, reads `window.location.hash` for `#wh_handoff=...`, calls `/v1/snippet/handoff/exchange`, stores resulting session token, calls `history.replaceState` to clear the fragment from URL.

## Files

- `packages/snippet/src/index.ts` — main entry, `window.wiredhowseAuth`
- `packages/snippet/src/storage.ts` — localStorage/sessionStorage tier
- `packages/snippet/src/api.ts` — fetch wrapper
- `packages/snippet/src/events.ts` — event emitter
- `packages/snippet/src/iframe.ts` — stub (filled out in 6b)
- `packages/snippet/src/ui/index.ts` — stub (filled out in 6b)
- `packages/snippet/build.ts` — esbuild config

## Tests

- Unit tests for storage layer, event emitter, queue replay, fragment parsing.

## Notable

- **Bundle target: ES2020, no polyfills.** IE11 not supported. Modern browsers only.
- **Per-site storage key** lets a single browser hold simultaneous sessions on multiple Sites without collision.
- **`history.replaceState` is mandatory** after consuming the fragment, so the handoff token doesn't sit visible in the URL bar.

## Review notes

Deliverable summary wasn't pasted into chat at the time (transition between chunks). 6b's references back to this work confirm it was completed correctly. Going forward, the build-log capture should happen at chunk close, not after the next chunk has started.

## Next chunk

6b: Iframe UI bundle. Switch to Opus 4.7 for the iframe + postMessage boundary.
