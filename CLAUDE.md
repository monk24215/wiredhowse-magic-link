# CLAUDE.md

Context file for Claude Code sessions on this repo. Read this first, every session.

## What this is

`wiredhowse-magic-link` — a free, hosted magic-link authentication service. Site Owners embed a JS snippet on their site; End Users get session-creating magic links by email. Also the SSO foundation for the wiredHowse app suite.

Production domain: `magic-link.wiredhowse.app`
GitHub: `monk24215/wiredhowse-magic-link`
Hosting: Railway

## Reading order on session start

1. **Always:** this file (`CLAUDE.md`).
2. **Always:** `PROJECT_BRIEF___wiredhowse-magic-link.md` (one-page-ish, defines scope + autonomy rules).
3. **Always:** `spec/00_overview.md` (architectural decisions, token vocab, glossary).
4. **As needed:** other spec files. Do **not** load them all preemptively. Each task touches 1-2 spec files at most:
   - Schema / DB work → `spec/01_database_schema.md`
   - Endpoint work → `spec/02_api_surface.md` + `spec/03_auth_flows.md`
   - Snippet work → `spec/04_snippet_api.md`
   - Threat / security review → `spec/05_threat_model.md`
   - Token / session work → `spec/06_session_token_design.md`
   - Rate limit work → `spec/07_rate_limiting.md`
   - Email / DNS / Resend → `spec/08_dns_email_setup.md`
   - Railway / deploy → `spec/09_railway_layout.md`
   - Repo / package structure → `spec/10_directory_structure.md`

If a task spans more than 3 spec files, the task is too big. Break it up.

## Operating agreement (from brief, restated)

Proceed without check-ins **except** for:
1. Schema changes after first prod deploy (migration plan first).
2. Destructive prod ops (drop table, force-push main, delete a Railway service, rotate a production secret).
3. Adding a new third-party paid dependency.
4. Anything that materially changes the threat model.

Everything else — implementation choices, refactors, semver-safe deps, tests, docs — autonomous. Commit and push when a chunk is done. Don't ask permission for normal work.

## Model policy

Default: **Sonnet 4.6**. Verify with `/model` at session start.

Switch to Opus 4.7 for these surfaces only:
- Magic-link redemption + handoff token exchange
- Snippet iframe sandbox + postMessage boundary
- Rate limiter (Redis Lua script)
- CORS / origin allowlist enforcement
- First-time database migration plans
- Anything where Sonnet has tried 2-3 times and stalled

Everything else stays on Sonnet.

## Stack (locked)

- Node.js 20 LTS + TypeScript (strict mode, no `any`)
- Fastify (api)
- Next.js 15 App Router (web)
- Drizzle ORM (db)
- Postgres 16+ (Railway managed)
- Redis (Railway managed, rate limits + ephemeral state)
- Resend (transactional email)
- pnpm workspaces (monorepo)
- esbuild (snippet bundle)
- Biome (lint + format)
- Vitest + testcontainers (test)

## Repo layout (top level)

```
packages/
  api/        — Fastify backend
  web/        — Next.js dashboard + public pages
  snippet/    — Browser snippet (vanilla TS, <15kb gzipped)
  db/         — Drizzle schema + migrations
  shared/     — Types + Zod schemas
spec/         — Technical spec (11 files)
docs/         — README, deployment, FAQs
scripts/      — Ops scripts (cleanup, archive purge, seed)
```

## Key architectural decisions (the easy-to-forget ones)

- **End User sessions live in `localStorage` on the customer site**, NOT in cookies. Third-party cookies are dead. Token sent as `Authorization: Bearer wh_s_...`. Cookies are only for first-party dashboard / `/me` contexts on `magic-link.wiredhowse.app`.
- **Opaque tokens, not JWTs.** Stored as `sha256` hashes in Postgres. Compared by indexed SQL equality.
  - **Exception:** the raw `wh_s_` session token is stored on `handoff_tokens.raw_session_token` for up to 60 seconds during the handoff window (magic-link redemption → snippet exchange). It is not stored anywhere else in the DB. The cleanup cron removes all handoff rows within 1 hour.
- **Fail closed.** No degraded mode. If Postgres or Redis is unreachable, return 5xx.
- **Server is authoritative on session validity, always.** Client cache is hint only.
- **CORS is strict per-Site.** Per-site `allowed_origins` list. No wildcards. Site key + Origin both checked.
- **Magic-link request returns 200 `{sent:true}` even when rate-limited per-email**, to prevent email enumeration. IP and domain rate limits return 429 normally.

## Token vocabulary

All `wh_*` tokens: `<prefix>` + `base64url(crypto.randomBytes(32))`. Stored as `sha256` hash. Never logged.

| Prefix     | What                       | Lifetime |
|------------|----------------------------|----------|
| `wh_s_`    | End User session           | 2-12 hr  |
| `wh_ml_`   | Magic link                 | 15 min   |
| `wh_ho_`   | Handoff token              | 60 sec   |
| `wh_ev_`   | Email verification         | 24 hr    |
| `wh_pr_`   | Password reset             | 1 hr     |
| `wh_os_`   | OAuth state                | 10 min   |
| `pk_`      | Site key (public)          | forever  |

## Things to NEVER do

- Log emails, IPs, or any `wh_*` token in plaintext. Hash via the `lib/hashing.ts` helper.
- Use `any` in TypeScript. Use `unknown` and narrow, or define the type properly.
- Add `// @ts-ignore` without a comment explaining why.
- Skip the tenant scoping (`WHERE site_owner_id = ?`) on dashboard queries.
- Use `Math.random()` for anything security-relevant. Always `crypto.randomBytes`.
- Hardcode the From address, API URLs, or any secret. All from env.
- Bypass rate limits in test code that gets shipped to prod. The `WH_DISABLE_RATE_LIMITS` env var must crash the boot if set in `NODE_ENV=production`.
- Mix marketing email into this subdomain. Ever.

## Context management

Conversations get long. When you finish a logical chunk:

1. Commit and push.
2. Tell the user "Chunk X complete — safe to `/clear`."
3. Wait for them to clear.

When approaching the context limit mid-task: `/compact` first, finish the immediate task, then prompt to `/clear`.

Each `/clear` is cheap because this file + the brief + `spec/00_overview.md` get you back to working context in three reads.

## Status (update this as we go)

- [x] Project brief approved
- [x] Technical spec written and approved
- [ ] FAQ PDFs generated
- [ ] Railway project skeleton
- [x] GitHub repo initialized with README + LICENSE + CI
- [x] `packages/db` schema implemented + migrations (0000 initial, 0001 handoff raw_session_token)
- [x] `packages/api` skeleton with health + readiness
- [x] `packages/shared` types
- [x] Magic-link request endpoint
- [x] Magic-link redemption endpoint
- [x] Session check endpoint
- [x] Handoff exchange endpoint
- [x] Sign-out endpoint
- [x] Rate limiter
- [x] Resend integration + email templates
- [ ] DNS records configured + Resend domain verified
- [x] `packages/snippet` core structure (6a) + iframe UI bundle (6b) + static asset routes (6c)
- [ ] `packages/web` dashboard pages
- [x] Site Owner signup + email verification (7a)
- [ ] Domain ownership verification (DNS + meta)
- [x] Google OAuth (Site Owners only) (7a)
- [x] `/me` self-service pages (7c)
- [x] Close-and-archive flow (7c)
- [ ] CSRF protection on dashboard mutations
- [ ] Cron service (cleanup + archive purge)
- [ ] CI: typecheck + lint + unit + integration
- [ ] Deploy to Railway
- [ ] DMARC ramp to `p=quarantine`
- [ ] Pre-launch checklist from `spec/05_threat_model.md`
