# Chunk 6c: Static serving + api integration

**Status:** ✅ Complete
**Model:** Sonnet 4.6
**Spec references:** `spec/04_snippet_api.md`, `spec/02_api_surface.md`

## Prompt sent to Claude Code

> Chunk 6c: static serving + integration with api per spec/04 and CLAUDE.md.
>
> Sonnet 4.6.
>
> Build:
>
> Routes in packages/api/src/routes/snippet-assets.ts (or wherever feels right — group these together):
> - GET /v1/snippet.js — serves packages/snippet/dist/snippet.js with Cache-Control: public, max-age=300, s-maxage=300 and Content-Type: application/javascript
> - GET /v1/snippet-ui.js — same, for the UI bundle
> - GET /v1/snippet.d.ts — TypeScript definitions, Cache-Control: public, max-age=86400 (24h, types change less)
> - GET /v1/snippet/ui — serves the HTML shell for the iframe. Minimal, references /v1/snippet-ui.js, no inline scripts. CSP header on this response: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors *;
>
> Build pipeline:
> - packages/snippet/package.json gets a build script that runs the existing esbuild config and outputs to dist/
> - packages/api/package.json's build script depends on snippet build
> - The api at runtime reads from packages/snippet/dist/.
>
> Bundle-size assertion:
> - Add a CI check or vitest test that asserts the gzipped size of packages/snippet/dist/snippet.js is under 15 KiB.
>
> When 6c lands, chunk 6 closes.

## Deliverable summary

### `packages/api/src/routes/snippet-assets.ts`

Four routes registered at `/v1`:

| Route | Content-Type | Cache-Control | Notes |
|---|---|---|---|
| `GET /v1/snippet.js` | `application/javascript` | `public, max-age=300, s-maxage=300` | Reads from `packages/snippet/dist/` |
| `GET /v1/snippet-ui.js` | `application/javascript` | Same | Same dist dir |
| `GET /v1/snippet.d.ts` | `text/plain` | `public, max-age=86400` | Inlined const — no file read |
| `GET /v1/snippet/ui` | `text/html` | `public, max-age=300` | HTML shell + strict CSP |

### CSP on iframe shell

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors *;
```

No inline scripts, no `on*` attributes — only `<script src="/v1/snippet-ui.js">`.

### Build ordering

`@wiredhowse/snippet: workspace:*` added to `packages/api`'s `devDependencies`. pnpm topological sort builds snippet before api during `pnpm -r build`.

## Files

- `packages/api/src/routes/snippet-assets.ts` (new)
- `packages/api/test/unit/snippet-assets.test.ts` (new)
- `packages/snippet/src/bundle-size.test.ts` (new)
- `packages/api/package.json` (workspace dep added)

## Tests

- 29 new unit tests for snippet-assets covering content-type, cache headers, CSP correctness, no-inline-scripts assertion, 500 on missing dist, `X-Request-Id`.
- 4 bundle-size guard tests — `skipIf` dist doesn't exist (graceful on fresh clones), active in CI after build. Both bundles pass <15 KiB.
- Totals: 106 API tests, 103 snippet tests — all green. Typecheck clean. Lint clean.

## Notable

- **`.d.ts` inlined as a constant** rather than read from disk. Types rarely change; the runtime simplification is worth the trade.
- **`frame-ancestors *`** on the iframe shell is intentional and correct — any customer site needs to be able to embed the auth iframe. The XSS/clickjacking defense lives in the iframe's own logic (origin-checked postMessage, no `innerHTML`), not in CSP.
- **Bundle-size guard with `skipIf`** prevents the test from failing on a fresh clone before `pnpm build` runs. In CI, the build runs first, so the guard becomes active.
- **Workspace dependency for build ordering** is the right pnpm-native way. Avoids manual script orchestration.

## Chunk 6 milestone

Customer-facing surface complete:

| Sub-chunk | Deliverable |
|---|---|
| 6a | Snippet core (storage, API, events, fragment handoff) |
| 6b | Iframe UI bundle (parent overlay + UI bundle, postMessage protocol) |
| 6c | Static serving from api (`/v1/snippet.js`, `/v1/snippet-ui.js`, `/v1/snippet.d.ts`, `/v1/snippet/ui`) |

A customer site could embed `<script src="https://magic-link.wiredhowse.app/v1/snippet.js" data-site-key="pk_...">` and have a working magic-link auth flow — assuming a Site row exists in the DB. The next chunk creates the dashboard that lets Site Owners actually register and create Sites.

## Review notes

Clean closeout. CSP is tight, bundle-size guard is reasonable, tests cover the surface. The customer-facing half of the service is done.

## Next chunk

Chunk 7: `packages/web` dashboard + the api endpoints it depends on (auth, dashboard, me). Four sub-chunks. Significant work — first chunk that touches two packages substantially.
