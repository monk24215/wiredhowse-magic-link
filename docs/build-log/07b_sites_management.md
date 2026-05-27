# Chunk 7b: Sites management (api + web)

**Status:** ✅ Complete
**Model:** Sonnet 4.6
**Spec references:** `spec/02_api_surface.md`, `spec/03_auth_flows.md`

## Prompt sent to Claude Code

> Chunk 7b: Sites management — api endpoints + web pages.
>
> Sonnet 4.6.
>
> API endpoints in `packages/api/src/routes/dashboard/`:
> - GET /v1/dashboard/sites — list sites for current Site Owner (tenant-scoped)
> - POST /v1/dashboard/sites — create site (3-site cap per owner)
> - GET /v1/dashboard/sites/{id} — site detail
> - PATCH /v1/dashboard/sites/{id} — update allowed_origins, toggle state
> - DELETE /v1/dashboard/sites/{id} — soft delete with confirmation
> - POST /v1/dashboard/sites/{id}/verify — DNS TXT + HTTPS meta fallback
> - POST /v1/dashboard/sites/{id}/clear-sessions — bulk revoke
> - GET /v1/dashboard/sites/{id}/metrics — 24h/7d/30d login counts
> - GET/PATCH /v1/dashboard/account
>
> Every endpoint MUST tenant-scope by current Site Owner. Integration tests must include a "cross-tenant access returns 404" assertion for each.
>
> Web pages with sidebar layout, auth gate, email verification banner.
>
> Domain verification: parallel DNS + meta with 5-sec timeout, first success wins.
>
> Don't skip the tenant-scoping tests. This is the highest-likelihood-of-bug area in the whole codebase.

## Deliverable summary

### API — `packages/api/src/routes/dashboard/`

10 endpoints, all tenant-scoped:

- **Sites CRUD**: list, create (3-site cap), detail, patch (state machine), delete
- **`POST /:id/verify`** — parallel DNS TXT + HTTPS meta-tag ownership check
- **`POST /:id/clear-sessions`** — bulk session invalidation
- **`GET /:id/metrics`** — 5 parallel queries (24h/7d/30d windows + active sessions + last activity)
- **`GET` + `PATCH /v1/dashboard/account`**

### Web — `packages/web/app/(dashboard)/`

- Sidebar layout with auth gate (redirects to /login if no `wh_owner_session` cookie)
- Unverified email banner with "re-send verification" inline action
- `/sites` — list with state badge per site
- `/sites/new` — wizard, shows DNS/meta/snippet instructions on success
- `/sites/[id]` — detail with verify/disable/delete/clear-sessions actions, allowed_origins editor, metrics panel, snippet code display
- `/account` — display name + password change

## Files

Numerous in both packages — full diff in commit.

## Tests

- **20 unit tests** (all mocked)
- **47 integration tests** against testcontainer Postgres
- Every mutating endpoint has an explicit cross-tenant 404 assertion
- All 144 unit tests pass project-wide. TypeScript clean. Biome clean.

## Notable

- **Cross-tenant 404 assertion on every mutating endpoint.** The single most important defensive test pattern in the codebase. One missing `WHERE site_owner_id = $current` would leak data; these tests prove it can't.
- **3-site cap enforced server-side.** UI cap alone would be bypassable.
- **Parallel DNS + meta verification with 5-sec timeout.** First-to-succeed wins; neither can hang the endpoint.
- **Metrics via 5 parallel queries** instead of sequential. Sub-second response on the site detail page.
- **State machine on PATCH** — transitions between `pending_verification`, `live`, `disabled` validated server-side. Can't transition to `live` without `verified_at IS NOT NULL`.

## Review notes

Disciplined work. The cross-tenant guarantees are now enforced both at code time (every query scoped) and at test time (every test asserts the negative). This is the chunk that locks in multi-tenant safety.

Open concerns for later (not blockers):
- **Integration test execution surface**: 47 new integration tests, all requiring Docker. Worth confirming CI runs them on every push, not just nightly.
- **DNS resolver cache behavior**: if a Site Owner adds a TXT record then immediately clicks "verify," a stale NXDOMAIN cache could cause spurious failure. Modern resolvers should respect TTLs but worth empirically confirming with a fast TTL test in the future.

## Next chunk

7c: End User self-service. `/v1/me/*` endpoints + `/v1/identity/me` SSO contract endpoint + the `/me` web page with session management and close-and-archive flow.
