# Chunk 7d — CSRF Protection + Auth Integration Tests

**Date:** 2026-05-27  
**Model:** Sonnet 4.6  
**Status:** ✅ Complete

---

## Prompt summary

Build CSRF middleware (double-submit cookie pattern), wire it into the dashboard and `/me` routes, update the web client fetch wrapper to send the `X-CSRF-Token` header, and add the auth integration tests deferred from chunk 7a.

---

## Stash salvage

Two stashes from an abandoned prior attempt were evaluated:

| Stash | Content | Decision |
|-------|---------|----------|
| `stash{0}` | `packages/api/src/middleware/csrf.ts` | Salvaged — clean, timing-safe comparison |
| `stash{1}` | `cookies.ts`, login/google/logout routes, dashboard/index.ts hook, shared errors, web/lib/api.ts, auth-login.test.ts update | Salvaged with one fix: `SameSite=Strict` → `SameSite=Lax` per `spec/06_session_token_design.md` |

---

## What was built

### CSRF middleware (`packages/api/src/middleware/csrf.ts`)

Double-submit cookie pattern:

- On safe methods (GET, HEAD, OPTIONS): passes through immediately.
- On mutations (POST, PATCH, DELETE): reads `wh_csrf` from the `Cookie` header and compares it to the `X-CSRF-Token` request header using `crypto.timingSafeEqual`. Length-mismatch is checked first to prevent zero-length bypass.
- 403 `CSRF_INVALID` on missing or mismatched token.
- `readCookieValue(header, name)` exported as a helper for route modules that need to inspect the CSRF cookie without importing the full middleware.

### Cookie utilities (`packages/api/src/lib/cookies.ts`)

- `buildCsrfCookie(rawToken)` — NOT HttpOnly (SPA must read it), SameSite=Lax, same Secure/Domain rules as session cookie.
- `clearCsrfCookie()` — Max-Age=0 clear.
- `buildOwnerSessionCookie` — corrected from SameSite=Strict back to SameSite=Lax per spec.

### Login / OAuth routes

Both `POST /v1/auth/login` and `GET /v1/auth/google/callback` now set both the `wh_owner_session` cookie and a fresh `wh_csrf` cookie on successful authentication. The CSRF token is generated with `crypto.randomBytes(32).toString('base64url')` — no prefix, just raw entropy.

### Logout route

`POST /v1/auth/logout` now requires CSRF validation (`[requireSiteOwnerSession, requireCsrfToken]` preHandlers) and clears both cookies on success.

### Dashboard namespace (`packages/api/src/routes/dashboard/index.ts`)

- `requireSiteOwnerSession` added at namespace level (runs before CSRF).
- `requireCsrfToken` added at namespace level (runs after auth — ensures unauthenticated requests get 401, not 403).
- All four sub-plugins (`siteRoutes`, `accountRoutes`, `siteMetricsRoutes`, `siteVerifyRoutes`) had their redundant per-plugin `requireSiteOwnerSession` hooks removed.

### `/me` namespace (`packages/api/src/routes/me/index.ts`)

- `requireEndUserSession` (existing) remains as auth guard.
- `requireCsrfToken` added as a second preHandler hook (mutations only).
- `onSend` hook: on successful GET responses where `request.endUser` is set and no `wh_csrf` cookie is already present, issues a fresh CSRF cookie so the `/me` page can use it for subsequent mutations.

### Web client (`packages/web/lib/api.ts`)

- `getCsrfToken()` reads `wh_csrf` from `document.cookie`.
- On every mutation (non-GET/HEAD/OPTIONS), the CSRF token is included as `X-CSRF-Token: <value>`.
- Server-side requests (no `document`) gracefully skip the token.

---

## Tests written

### `packages/api/test/unit/csrf.test.ts` (14 unit tests)

- Safe methods pass without CSRF.
- POST/PATCH/DELETE without header → 403 CSRF_INVALID.
- POST/PATCH/DELETE without cookie → 403 CSRF_INVALID.
- Mismatched header vs cookie → 403 CSRF_INVALID.
- Length mismatch (padded header) → 403.
- URL-encoded cookie values decoded correctly.
- Matching pair → 200 (POST, PATCH, DELETE each verified).
- Snippet routes without hook: POST succeeds with no CSRF.

### `packages/api/test/integration/auth-flows.test.ts` (deferred from 7a)

Uses testcontainer Postgres + Drizzle migrations. Email service mocked to capture verification/reset URLs.

Flows covered:
- **A. Signup → verify-email → login → logout:** 201 on signup, 403 before verify, verify sets `email_verified_at`, login sets both cookies with correct attributes, logout revokes session and clears both cookies with Max-Age=0.
- **B. Password reset:** `request-password-reset` always 200 (enumeration prevention), `reset-password` updates password, old password fails after reset, new password works, all sessions revoked on reset.
- **C. Google OAuth:** new account created on first login, existing password account linked (auth_method → `both`), state replay rejected, consumed state rejected, Google token exchange failure redirects to error page.
- **D. Account lockout:** locks after 10 failures with 423 ACCOUNT_LOCKED, correct password blocked while locked, unlocks after `locked_until` expires, `failed_login_count` reset on success.
- **E. Dummy-verify timing:** `dummyVerify` called when email not found, not called when real account exists.
- **F. Email verification token single-use:** second use returns 404, expired token returns 404.
- **G. Password reset token single-use:** second use returns 404, expired token returns 404.

### Updated existing unit tests

`me-profile.test.ts`, `me-sessions.test.ts`, `me-close-archive.test.ts`, `dashboard-sites.test.ts`, `auth-login.test.ts` — all mutation requests updated with `CSRF_HEADERS` constants containing matching cookie + header pairs.

### Updated existing integration test

`me.test.ts` — all 10 mutation requests updated with `csrfHeaders()` helper.

---

## Notable decisions

1. **Auth before CSRF in dashboard namespace.** Moving `requireSiteOwnerSession` to namespace level before `requireCsrfToken` ensures unauthenticated requests receive 401 (not 403). Without this ordering, CSRF fires first and unauthenticated clients get a confusing 403. Sub-plugins' redundant auth hooks removed to avoid double DB hits.

2. **CSRF for `/me` routes despite Bearer auth.** End User sessions use `Authorization: Bearer`, which is not auto-sent by browsers and thus not CSRF-vulnerable. CSRF was added anyway per spec, making the `/me` page defense-in-depth consistent. The cookie is issued on the first GET so the SPA can read it before mutations.

3. **SameSite=Lax (not Strict) for both cookies.** Spec mandates Lax. Strict would break navigations from email links, Google OAuth redirects, and any top-level GET arriving from an external origin.

4. **CSRF cookie is not HttpOnly.** By design: the SPA must read it via `document.cookie` to echo it in `X-CSRF-Token`. This is the canonical double-submit pattern.

---

## Files changed

```
packages/api/src/middleware/csrf.ts        — new (readCookieValue exported)
packages/api/src/lib/cookies.ts            — CSRF cookie builders + SameSite=Lax fix
packages/api/src/routes/auth/login.ts      — sets CSRF cookie on login
packages/api/src/routes/auth/google.ts     — sets CSRF cookie on OAuth login
packages/api/src/routes/auth/logout.ts     — CSRF check + clears CSRF cookie
packages/api/src/routes/dashboard/index.ts — auth + CSRF hooks at namespace level
packages/api/src/routes/dashboard/sites.ts         — remove per-plugin auth
packages/api/src/routes/dashboard/account.ts       — remove per-plugin auth
packages/api/src/routes/dashboard/site-metrics.ts  — remove per-plugin auth
packages/api/src/routes/dashboard/site-verify.ts   — remove per-plugin auth
packages/api/src/routes/me/index.ts        — CSRF hook + onSend CSRF cookie issuance
packages/shared/src/errors.ts              — CSRF_INVALID error code
packages/web/lib/api.ts                    — getCsrfToken() + X-CSRF-Token on mutations
packages/api/test/unit/csrf.test.ts        — new, 14 tests
packages/api/test/integration/auth-flows.test.ts  — new, 34 tests
packages/api/test/unit/auth-login.test.ts  — updated for CSRF + SameSite=Lax
packages/api/test/unit/me-profile.test.ts          — CSRF headers on mutations
packages/api/test/unit/me-sessions.test.ts         — CSRF headers on mutations
packages/api/test/unit/me-close-archive.test.ts    — CSRF headers on mutations
packages/api/test/unit/dashboard-sites.test.ts     — CSRF headers on mutations
packages/api/test/integration/me.test.ts           — CSRF headers on mutations
docs/build-log/07d_csrf_auth_integration_tests.md  — this file
```

---

## Test results

- **Unit tests:** 182/182 passing (14 new CSRF tests, all existing tests updated)
- **Integration tests:** Require Docker (testcontainers) — run in CI. Code follows identical pattern to existing integration tests (`magic-redeem.test.ts`, `me.test.ts`).
- **Typecheck:** Clean across `api`, `web`, `shared`.
- **Lint:** Clean (Biome).
