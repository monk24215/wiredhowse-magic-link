# Chunk 7a: Site Owner auth (api + web)

**Status:** ✅ Complete
**Model:** Sonnet 4.6
**Spec references:** `spec/02_api_surface.md`, `spec/03_auth_flows.md`, `spec/06_session_token_design.md`

## Prompt sent to Claude Code

> 7a: Site Owner auth — api endpoints + web pages
>   - api: POST /v1/auth/signup, /v1/auth/login, /v1/auth/logout, /v1/auth/verify-email, /v1/auth/request-password-reset, /v1/auth/reset-password
>   - api: GET /v1/auth/google/start, GET /v1/auth/google/callback
>   - web: /signup, /login, /verify, /reset-password pages (Next.js App Router, shadcn/ui)
>   - Cookie-based dashboard session (wh_owner_session) with 30-day sliding TTL
>   - argon2id password hashing
>   - Account lockout after 10 failed attempts per hour
>   - Sonnet 4.6 default, Opus 4.7 only if Google OAuth flow gets fiddly

## Deliverable summary

### API — `packages/api/src/routes/auth/`

| Endpoint | What it does |
|---|---|
| `POST /v1/auth/signup` | argon2id hash, create account, send `wh_ev_` verify email (non-blocking) |
| `POST /v1/auth/login` | DB lockout after 10 failures/hr, **dummy-verify timing protection**, 30-day sliding `wh_owner_session` cookie |
| `POST /v1/auth/logout` | Revokes session row, clears cookie |
| `POST /v1/auth/verify-email` | Consumes `wh_ev_` token, stamps `email_verified_at` |
| `POST /v1/auth/request-password-reset` | Silent 200 (enumeration prevention), sends `wh_pr_` email |
| `POST /v1/auth/reset-password` | Consumes `wh_pr_`, re-hashes password, **revokes all sessions** |
| `GET /v1/auth/google/start` | Generates `wh_os_` state in DB, redirects to Google |
| `GET /v1/auth/google/callback` | CSRF-validates state, token exchange via native fetch, find-or-create owner |

### Web — `packages/web/`

- Tailwind CSS v4 + `@tailwindcss/postcss`
- shadcn/ui-style components (Button, Input, Label, Card, Alert) — built locally, no shadcn CLI dependency
- `lib/api.ts` — typed fetch wrapper through Next.js `/api/v1/*` rewrite proxy to internal api service
- `/(auth)/layout.tsx` — centred auth shell
- `/signup`, `/login`, `/verify`, `/reset-password` — Client Component forms with per-error-code messaging

## Files

### API
- `packages/api/src/routes/auth/signup.ts`
- `packages/api/src/routes/auth/login.ts`
- `packages/api/src/routes/auth/logout.ts`
- `packages/api/src/routes/auth/verify-email.ts`
- `packages/api/src/routes/auth/request-password-reset.ts`
- `packages/api/src/routes/auth/reset-password.ts`
- `packages/api/src/routes/auth/google.ts` (start + callback)
- `packages/api/src/lib/password.ts` — argon2id helpers + dummy verify
- `packages/api/src/lib/cookies.ts`
- `packages/api/src/lib/time.ts` (added `addHours`, `addDays`, `addMinutes`)
- `packages/api/src/middleware/auth-owner.ts` — sliding TTL update
- `packages/api/src/config.ts` — `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_COOKIE_DOMAIN`
- `packages/shared/src/errors.ts` — `EMAIL_ALREADY_REGISTERED` added

### Web
- `packages/web/app/(auth)/layout.tsx`
- `packages/web/app/(auth)/signup/page.tsx`
- `packages/web/app/(auth)/login/page.tsx`
- `packages/web/app/(auth)/verify/page.tsx`
- `packages/web/app/(auth)/reset-password/page.tsx`
- `packages/web/components/ui/*` (Button, Input, Label, Card, Alert)
- `packages/web/lib/api.ts`
- `packages/web/next.config.ts` — `/api/v1/*` rewrite to internal api

## Tests

- 124 unit tests pass (12 new: 6 signup scenarios, 12 login scenarios).
- Integration tests for the auth endpoints were not added in this chunk — covered by the existing testcontainer setup in principle, but the specific auth flow tests are deferred. Flag for 7d or a dedicated cleanup pass.

## Notable

- **Dummy-verify timing protection on login.** Non-existent users still trigger an argon2 verification against a dummy hash so timing can't distinguish "no user" from "wrong password." Standard practice, easy to skip, Claude Code got it right unprompted.
- **Reset-password revokes all sessions.** If a Site Owner resets their password, every device is signed out. Not in the prompt; correct default.
- **Google OAuth uses native `fetch`.** No `googleapis` SDK, no Passport. Smaller dependency surface. Token exchange handled inline with signature verification.
- **Sliding TTL on dashboard session.** Each use of a valid `wh_owner_session` cookie extends its expiry by 30 days from now. Implemented in `auth-owner.ts` middleware.
- **shadcn/ui-style components built locally** rather than via the shadcn CLI. Trade-off: simpler dep tree now, but if component count grows past ~8 unique components, switching to the CLI gets compelling for update tooling.
- **CSRF protection intentionally not present.** It's chunk 7d. Dashboard endpoints are CSRF-vulnerable until then — must not deploy before 7d lands.

## Review notes

Strong chunk. The dummy-verify and revoke-all-on-reset details are signs the model genuinely engaged with the security model rather than just satisfying the prompt. The native-fetch Google OAuth implementation is a clean refusal to take on an unnecessary dependency.

Two follow-ups for later:
1. Integration tests for the auth flow (sweep in 7d or sooner).
2. Decide whether to formalize the shadcn CLI before chunk 7b adds another half-dozen components.

## Next chunk

7b: Sites management — list, create, verify domain, detail view with metrics + snippet code + allowed_origins editor, disable toggle, clear sessions, plus the account page.
