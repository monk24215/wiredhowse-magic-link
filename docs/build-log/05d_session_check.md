# Chunk 5d: POST /v1/snippet/session/check

**Status:** ✅ Complete
**Model:** Sonnet 4.6
**Spec references:** `spec/02_api_surface.md`, `spec/06_session_token_design.md`

## Prompt sent to Claude Code

> Chunk 5d: POST /v1/snippet/session/check per spec/02.
>
> Back to Sonnet 4.6 — this is a validation-only endpoint, not auth-critical surface.
>
> Flow:
> - X-Site-Key + Origin enforcement (existing helpers)
> - Token may come from body or be absent (absent = no session yet, return valid:false, not an error)
> - If present: format check, hash, SELECT against sessions WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now() AND site_id = (resolved from X-Site-Key)
> - Critical: WHERE site_id = ... so a stolen token from Site A can't authenticate against Site B.
> - On valid: UPDATE sessions.last_used_at + end_users.last_seen_at, return session + end_user
> - On invalid: return { valid: false }, 200 status. Never 401 here — this endpoint asks "is this token valid for this site" and the answer "no" is informational, not an auth failure.
>
> Rate limit: checkSessionCheckPerIp from chunk 4c. 120 per minute per IP per spec.
>
> No session sliding/renewal. Expires_at is fixed at issuance per spec/06.

## Deliverable summary

### POST /v1/snippet/session/check

- X-Site-Key + Origin enforced via shared helpers.
- Rate limit: `checkSessionCheckPerIp` (120/min/IP).
- Optional body `{ token?: string }` — absent or wrong-format short-circuits to `{ valid: false }` before any DB hit.
- Single SELECT with 4 predicates: token_hash match + `revoked_at IS NULL` + `expires_at > now` + `site_id = requester site` (cross-site defense-in-depth).
- On valid: side-effects `sessions.last_used_at` and `end_users.last_seen_at`; `expires_at` is never extended (spec/06).
- On invalid for any reason: `{ data: { valid: false } }`, always 200 — informational, not 401.

## Files

- `packages/api/src/routes/snippet/session-check.ts`
- `packages/api/src/routes/snippet/shared.ts` — extracted `resolveSite` helper (third snippet route triggered the deduplication; `magic-link-request.ts` and `handoff-exchange.ts` updated to import from here)

## Tests

- 16 unit tests: site-key errors, origin rejection, rate-limit 429, every `valid:false` path (absent body, no token field, bad format, not-found), happy path with update call counts, CORS preflight, response headers.
- 14 integration tests: full magic-link → redeem → exchange → check chain; timestamp side-effects verified in DB; expired/revoked/cross-site token rejection; header/CORS checks.

## Notable

- **`resolveSite` extracted into `shared.ts`.** Three routes was the right trigger to deduplicate. Future snippet routes (5e) inherit this helper automatically.
- **Cross-site `site_id` predicate.** Even though session tokens are 256-bit random and a "collision against the wrong site" is astronomically unlikely, the predicate is almost free and adds defense in depth.
- **Integration tests now exercise the full happy-path chain.** request → redeem → exchange → check, all in one test, all using testcontainer Postgres. By the end of chunk 5, the entire End User auth lifecycle is verified by tests.

## Review notes

Clean Sonnet output. No surprises. The shared helper extraction is exactly the kind of judgment call worth letting Sonnet make autonomously.

## Next chunk

5e: POST /v1/snippet/sign-out. Closes chunk 5.
