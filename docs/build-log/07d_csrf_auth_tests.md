# Chunk 7d: CSRF protection + auth integration tests

**Status:** ✅ Complete
**Model:** Sonnet 4.6
**Spec references:** `spec/06_session_token_design.md`, `spec/02_api_surface.md`
**Commit:** `2f1d86b`

## Prompt sent to Claude Code

> Chunk 7d: Finish CSRF protection + add the deferred auth integration tests.
>
> First, examine the two stashes from the abandoned 7d attempt and decide for each: is the work salvageable or should it be rewritten from spec?
>
> Then build:
>
> CSRF middleware (`packages/api/src/middleware/csrf.ts`):
> - Double-submit cookie pattern per spec/06
> - Issue wh_csrf cookie (non-HttpOnly, Secure, SameSite=Lax) on first dashboard GET
> - Validate X-CSRF-Token header matches wh_csrf cookie on every POST/PATCH/DELETE under /v1/auth/*, /v1/dashboard/*, /v1/me/*
> - Snippet routes exempt (Bearer auth, cross-origin)
> - Magic redemption exempt (browser navigation, not API call)
>
> Web client: read wh_csrf from document.cookie, send X-CSRF-Token on every mutating request.
>
> Auth integration tests: full signup → verify → login → logout flow; password reset; Google OAuth (mock token endpoint); lockout; dummy-verify timing protection; single-use token enforcement on email verification + password reset.
>
> CSRF tests: missing token returns 403; mismatched returns 403; valid succeeds; snippet routes still work; GETs don't require CSRF.

## Deliverable summary

- **CSRF double-submit middleware** (`packages/api/src/middleware/csrf.ts`) with timing-safe comparison
- **CSRF cookies issued** on login (both password + OAuth paths) and on first `/me` GET
- **Dashboard namespace consolidated**: auth → CSRF → route handlers, no duplicate DB hits
- **Logout clears** both session cookie and CSRF cookie
- **Web client** reads `wh_csrf` from `document.cookie` and sends `X-CSRF-Token` header on every mutation
- **Full auth integration test suite** (`auth-flows.test.ts`): signup/verify/login/logout, password reset, Google OAuth, lockout, timing protection, single-use token enforcement

## Tests

- **182/182 unit tests passing** project-wide
- **34 integration tests** in `auth-flows.test.ts` (testcontainer-based, CI-only locally)
- TypeScript clean across api, web, shared
- Biome lint clean

## Notable

- **Timing-safe comparison on CSRF tokens.** Tokens are short and don't have the same timing-attack profile as session tokens, but constant-time comparison is defense in depth and costs nothing.
- **Two issuance paths for the CSRF cookie.** Owner-side: on dashboard login (password or OAuth). End User side: on first `/me` GET. Two paths because End Users authenticate via Bearer-from-localStorage, not cookies — they need an explicit issuance moment when they land on `/me`.
- **Dashboard namespace consolidation.** Previous middleware chain re-fetched the owner row in CSRF middleware after auth middleware had already loaded it. Refactored to single load, passed down the chain. Minor perf win, cleaner code.
- **Snippet routes correctly exempt.** CSRF protects against cookie-bound auth being exercised by attacker-controlled origins. Snippet routes use Bearer auth from cross-origin clients by design — CSRF doesn't apply.
- **Stash recovery decision:** The salvaged work from `stash@{0}` (untracked `csrf.ts`) and `stash@{1}` (modified files) was evaluated and partially merged with corrections. Final implementation differs from the abandoned attempt where the spec required more strictness (e.g., the consolidated namespace, the two-path issuance).

## Chunk 7 milestone

Dashboard + self-service complete:

| Sub-chunk | Surface |
|---|---|
| 7a | Site Owner auth (signup, login, password reset, Google OAuth) |
| 7b | Sites management (CRUD, domain verification, metrics, clear sessions) |
| 7c | End User self-service (`/v1/me/*`, `/v1/identity/me`, /me page, close-and-archive) |
| 7d | CSRF protection across all mutating endpoints + auth integration tests |

A Site Owner can register, verify, log in, create up to 3 sites, embed the snippet on their domain, and protect their pages. An End User who hits a protected page receives a magic link, redeems it, gets a session, can manage that session at /me, and can fully archive their data. Every state-changing API endpoint is CSRF-protected. Every auth surface has integration test coverage.

## Review notes

Strong closeout. The stash-evaluation discipline at the start of the chunk (compare salvageable work to spec-fresh work, take the better) is a pattern worth keeping for any future "resume after crash" situations. The two-path CSRF issuance is a thoughtful detail that the spec didn't explicitly call out but follows directly from the architecture.

Build is now functionally complete pending:
- Chunk 8: Cron service (cleanup + archive purge)
- Chunk 9: Railway deploy + DNS + DMARC ramp

Both are operational chunks; no remaining feature work.

## Next chunk

8: Cron service. Scheduled cleanup of expired magic_links, handoff_tokens, oauth_state, expired email_verifications and password_resets. Daily session cleanup, 24-month archive purge, 90-day audit log retention.
