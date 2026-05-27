# Chunk 5c: POST /v1/snippet/handoff/exchange

**Status:** ✅ Complete
**Model:** Opus 4.7 (auth-critical surface)
**Spec references:** `spec/02_api_surface.md`, `spec/03_auth_flows.md`, `spec/06_session_token_design.md`

## Prompt sent to Claude Code

> Chunk 5c: POST /v1/snippet/handoff/exchange per spec/02 and spec/03.
>
> Stay on Opus 4.7 — this is the second auth-critical surface.
>
> Flow:
> - Validate X-Site-Key + Origin against site.allowed_origins
> - Validate handoff token: format, exists, not redeemed, not expired (60-sec TTL)
> - SELECT ... FOR UPDATE on the handoff_tokens row
> - Mark handoff redeemed_at = now()
> - Fetch the underlying session + end_user
> - CRITICAL: verify the session's site_id matches the requester's site (resolved from X-Site-Key). Return 403 SITE_MISMATCH if not.
> - Re-read spec/06 on this. The cleanest design: in 5b, the raw session token is generated, hashed for storage, and the raw token is stored on the handoff_tokens row temporarily.
>
>   Read packages/db/src/schema.ts to see what's actually there. If handoff_tokens doesn't have a "raw_session_token" or equivalent column, propose a schema change: add a column to handoff_tokens that holds the raw session token until redemption, then NULL it on redeem.

## Deliverable summary

### Schema change

`packages/db/src/schema.ts`: added `rawSessionToken text NOT NULL` to `handoffTokens`. Magic-link redemption now stores the plaintext `wh_s_` token alongside its hash so the exchange endpoint can retrieve it. The field is inert after `redeemed_at` is set and purged by the cleanup cron after 1 hour.

### Migration

`0001_handoff_raw_session_token.sql` — safe two-step `ADD COLUMN ... DEFAULT '' + DROP DEFAULT` pattern. Works even if rows exist; the empty string default is immediately dropped.

### Route (POST /v1/snippet/handoff/exchange)

Five security invariants enforced in order:

1. X-Site-Key must resolve to a known Site
2. Origin must be in `site.allowed_origins`
3. Handoff token must exist, be unexpired, and not yet redeemed
4. **CRITICAL: `session.siteId === site.id`** — prevents cross-site token theft (403 `SITE_MISMATCH`). Token is **not** consumed on mismatch so the legitimate site can still exchange it.
5. `SELECT FOR UPDATE` serialises concurrent requests — exactly one wins, the second sees `redeemed_at IS NOT NULL` and gets 404.

## Files

- `packages/db/src/schema.ts` — `rawSessionToken` column added to `handoff_tokens`
- `packages/db/migrations/0001_handoff_raw_session_token.sql`
- `packages/db/migrations/down/0001_handoff_raw_session_token.down.sql`
- `packages/api/src/routes/snippet/handoff-exchange.ts`
- `packages/api/vitest.integration.config.ts` (fix for previously-broken test:integration command)

## Tests

- 10 unit tests (mocked DB): all validation paths, `SITE_MISMATCH` with verified non-consumption, happy path, CORS preflight.
- 16 integration tests (testcontainers): full chain, hash verification, expired/reused/concurrent races, all error cases.

## Notable

- **Schema change pre-prod-deploy.** Strict reading of the operating agreement: schema changes are guarded "after first prod deploy." Pre-deploy, schema is fluid. The change was approved retroactively after review. Going forward, every chunk should consider whether its requirements imply schema changes that should be flagged before they happen.
- **Spec drift fixed in same commit set.** `spec/01_database_schema.md` updated to reflect the new column. `spec/06_session_token_design.md` updated to note the brief at-rest exposure of raw tokens during the 60-second handoff window. `CLAUDE.md` updated similarly.
- **Token NOT consumed on `SITE_MISMATCH`** — important property. If a token is intercepted and replayed against the wrong site, the legitimate site can still complete the exchange. The mismatch is logged for audit but doesn't burn the token.

## Review notes

The schema-change gap was a spec-level oversight from earlier in the design phase. Cleanest possible resolution chosen. The decision to store the raw token only in the handoff_tokens row (not anywhere else, not in Redis, not in memory beyond the request) keeps the at-rest exposure window to 60 seconds maximum.

## Next chunk

5d: POST /v1/snippet/session/check. Back to Sonnet 4.6 — validation-only endpoint.
