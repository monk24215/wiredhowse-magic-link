# Chunk 5b: GET /v1/magic/redeem + /v1/magic/preflight

**Status:** ✅ Complete
**Model:** Opus 4.7 (auth-critical surface per model policy)
**Spec references:** `spec/02_api_surface.md`, `spec/03_auth_flows.md`, `spec/06_session_token_design.md`

## Prompt sent to Claude Code

> Chunk 5b: GET /v1/magic/redeem and GET /v1/magic/preflight per spec/02 and spec/03.
>
> Switch to Opus 4.7 for this sub-chunk per the model policy. This is the redemption surface — the one place a small mistake compromises sessions.
>
> /v1/magic/preflight:
> - Validates token format + existence + not-redeemed + not-expired
> - Returns masked email (first + last char + domain), site_domain, expires_at
> - Idempotent. No DB writes. Same response on every call until token expires/redeems.
>
> /v1/magic/redeem:
> - Full redemption flow in a single transaction:
>   1. Validate token (exists, not redeemed, not expired)
>   2. Validate site state === 'live'
>   3. Find or create end_users row by email (case-insensitive)
>   4. Count prior logins in login_history for (end_user_id, site_id)
>   5. Compute expires_at from tier (0→2h, 1-3→4h, 4-6→6h, 7+→12h)
>   6. INSERT sessions row with hashed token, computed expiry, login_count_at_creation
>   7. INSERT handoff_tokens row (60-second TTL) pointing to session
>   8. INSERT login_history row
>   9. UPDATE magic_links SET redeemed_at = now() and redeemed_ip_hash
>   10. Issue 302 redirect to first allowed origin with #wh_handoff=<token> fragment
>
> Tier calculation lives in services/login-tier.ts so it can be unit-tested in isolation.
>
> Transaction is critical. If any step fails, the magic link must NOT be marked redeemed. Use Drizzle's db.transaction(). Test this — write a test that forces a handoff INSERT failure and asserts the magic link stays unredeemed.

## Deliverable summary

### GET /v1/magic/preflight

- Validates token format, existence, not-redeemed, not-expired.
- Returns `{ email: "a***e@example.com", site_domain, expires_at }`.
- Idempotent — no DB writes; `Cache-Control: no-store`.

### GET /v1/magic/redeem

- `SELECT ... FOR UPDATE` prevents concurrent double-redemption.
- Full atomic transaction: find-or-create end_users → count logins → INSERT sessions → INSERT handoff_tokens (60s TTL) → INSERT login_history → UPDATE magic_links.redeemed_at (**last**, for clean rollback semantics).
- `loginTierDuration()` drives session expiry (2h/4h/6h/12h).
- 302 redirect to `allowedOrigins[0]#wh_handoff=wh_ho_...` (fragment survives redirect; no token in server logs).
- IP mismatch warning logged (hashed IP only, no PII).
- HTML error pages for 404/410 (not JSON — this is a browser navigation endpoint).

## Files

- `packages/api/src/routes/magic/preflight.ts`
- `packages/api/src/routes/magic/redeem.ts`
- `packages/api/src/services/login-tier.ts` — pure function for tier → duration
- `packages/api/src/lib/mask-email.ts` — email masking
- `packages/api/src/routes/magic/error-page.ts` — minimal HTML error renderer

## Tests

- 13 unit tests for `loginTierDuration` (all 4 tiers + boundaries + exact second values)
- 8 unit tests for `maskEmail`
- 20 integration tests against a real Postgres testcontainer — including transaction rollback verification, double-redemption prevention, end-user reuse, fragment Location header format, and all error cases

Total quality gates: Biome 0 errors · TypeScript 0 errors · 36/36 unit tests pass.

## Notable

- **`SELECT ... FOR UPDATE` for concurrent redemption protection.** Without this, two simultaneous clicks on the same magic link could create two sessions. With it, exactly one wins; the second sees `redeemed_at IS NOT NULL` and gets the error page.
- **Magic-link UPDATE is the LAST step in the transaction.** If any earlier step fails (session insert, handoff insert, history insert), the rollback leaves the link unredeemed and the user can retry. Putting the UPDATE first would mean a transient DB failure consumes the link permanently.
- **Fragment redirect, not query string.** `#wh_handoff=...` survives the 302, doesn't appear in server logs, doesn't get sent on subsequent navigation. The handoff token never crosses the wire as a URL parameter.
- **Integration tests require Docker** (testcontainer-based). Don't run on dev machines without it; CI handles them.

## Review notes

Cleanest implementation possible of this surface. The `FOR UPDATE` + last-step UPDATE combination handles every concurrency and failure case correctly. This was the most security-critical chunk in the whole build; Opus 4.7 earned its keep here.

## Next chunk

5c: POST /v1/snippet/handoff/exchange. Stay on Opus. The "how does the api retrieve the raw session token at exchange time" gap was flagged before 5c started — see that chunk's notes for the schema-change resolution.
