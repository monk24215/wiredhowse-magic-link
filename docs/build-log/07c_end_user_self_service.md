# Chunk 7c: End User self-service (api + web)

**Status:** ✅ Complete
**Model:** Sonnet 4.6
**Spec references:** `spec/02_api_surface.md`, `spec/06_session_token_design.md`
**Commit:** `41edba3`

## Prompt sent to Claude Code

> Resuming after a session crash. Read CLAUDE.md and PROJECT_BRIEF___wiredhowse-magic-link.md and spec/00_overview.md. Two stashes exist with partial chunk 7d work — leave them alone; we'll handle them in a later session.
>
> Build chunk 7c: End User self-service.
>
> API endpoints in `packages/api/src/routes/me/`:
> - GET /v1/me — profile
> - PATCH /v1/me — update display_name only
> - GET /v1/me/sessions — list active sessions with is_current flag
> - POST /v1/me/sessions/{id}/revoke — revoke one, 204
> - POST /v1/me/sessions/revoke-all — revoke all including current, 204
> - POST /v1/me/close-and-archive — atomic db.transaction(): aggregate session_summary into archived_end_users (email_hash = sha256(lowercase(email)), no plaintext) → delete sessions cascades → delete login_history cascades → delete end_users. Return 204.
> - GET /v1/me/export — GDPR export
>
> SSO contract in `packages/api/src/routes/identity/`:
> - GET /v1/identity/me — stable v1 contract for other wiredHowse apps.
>
> All require Authorization: Bearer wh_s_<token>.
>
> Web page in `packages/web/app/me/`:
> - /me — Client Component, reads session token from localStorage, Bearer-authenticated. Profile, session list with revoke buttons, revoke-all, close-and-archive flow with typed confirmation modal, download data button. After close-and-archive: clear localStorage and redirect to a generic confirmation page. Do NOT echo back the deleted email anywhere.
>
> Tests:
> - Unit per endpoint
> - Integration: full close-and-archive including rollback-on-failure test; returning-user-after-archive gets fresh end_users row with zero archive linkage; cross-user isolation; /v1/identity/me returns same shape as /v1/me
>
> Critical: close-and-archive must be atomic. archived_end_users.email_hash never stores plaintext. session_summary is aggregated counts only, no PII.

## Deliverable summary

| Surface | File | Status |
|---|---|---|
| GET /v1/me, PATCH /v1/me | `packages/api/src/routes/me/profile.ts` | ✅ |
| GET /v1/me/sessions, POST /v1/me/sessions/:id/revoke, POST /v1/me/sessions/revoke-all | `packages/api/src/routes/me/sessions.ts` | ✅ |
| POST /v1/me/close-and-archive (atomic tx, sha256 email hash, no PII) | `packages/api/src/routes/me/close-archive.ts` | ✅ |
| GET /v1/me/export (GDPR, no token/ip hashes) | `packages/api/src/routes/me/export.ts` | ✅ |
| GET /v1/identity/me (SSO contract) | `packages/api/src/routes/identity/index.ts` | ✅ |
| /me Client Component | `packages/web/app/me/page.tsx` | ✅ |
| /me/archived confirmation page | `packages/web/app/me/archived/page.tsx` | ✅ |

## Tests

- **168 unit tests passing project-wide** (includes new me-profile, me-close-archive, me-sessions plus all prior tests)
- Integration tests written but require Docker to run locally; configured as CI-only

## Notable

- **Atomic close-and-archive in `db.transaction()`.** All four destructive operations in one transaction — if any fails, all roll back. Magic-link redemption in chunk 5b uses the same pattern; this is now the standard for any multi-step destructive operation in the codebase.
- **`archived_end_users.email_hash = sha256(lowercase(email))`.** Plaintext email never copied to the archive. A returning user with the same email creates a fresh `end_users` row with zero linkage to their prior archive. Login tier resets to 0.
- **`session_summary` is aggregated counts only** — per-site login counts and date ranges. No IPs, no user-agent strings, no PII.
- **`/v1/me/export` excludes `token_hash` and `ip_hash` columns.** GDPR export gives the user their data, not the security-sensitive operational metadata. Sessions are exported as `{id, site, created_at, expires_at, last_used_at}` — no token material.
- **Separate `/me/archived` confirmation page** rather than rendering "you've been archived" on `/me`. After archive, `/me` would 401 (no session); the dedicated archived page is a generic success state with no echo of the deleted account.
- **`/v1/identity/me` lives in `routes/identity/index.ts`**, a distinct directory from `routes/me/`. Mirrors the spec's distinction between End User self-service and the SSO contract surface.

## Context

This chunk was built immediately after a session crash caused by API billing exhaustion during a prior chunk 7d attempt. The crashed 7d work is preserved in two git stashes:

- `stash@{0}` — untracked `csrf.ts` middleware
- `stash@{1}` — modified files retrofitting CSRF across existing routes

These will be revisited in the next session as the start of a clean 7d.

## Review notes

Clean chunk. The separate `/me/archived` page is a UX detail that prevents a real failure mode — if the archived-state message rendered on `/me`, a user could screenshot/share it with their email visible. The dedicated generic page removes that surface.

Discipline reset is working: `/model sonnet` enforced, `/clear` between chunks, short focused brief.

## Next chunk

7d: Recover the CSRF work from stash, finish it properly, add the auth integration tests that were deferred from 7a. Standalone session, fresh `/clear`, examines the stash before deciding what to keep vs. rewrite.
