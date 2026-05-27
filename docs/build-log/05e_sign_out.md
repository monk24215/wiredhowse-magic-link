# Chunk 5e: POST /v1/snippet/sign-out

**Status:** ✅ Complete
**Model:** Sonnet 4.6
**Spec references:** `spec/02_api_surface.md`

## Prompt sent to Claude Code

> Chunk 5e: POST /v1/snippet/sign-out per spec/02.
>
> Sonnet 4.6.
>
> Flow:
> - X-Site-Key + Origin enforced (existing helpers via shared.ts)
> - Authorization: Bearer wh_s_<token> required
> - Validate token format. On malformed: still return 200 { signed_out: true } per spec — idempotent, no information leak.
> - Hash token, UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL AND site_id = (resolved from X-Site-Key)
> - Always return 200 { data: { signed_out: true } } regardless of whether a row was updated. Idempotent: signing out a non-existent or already-revoked session returns the same success response. Don't leak which it was.
>
> Rate limit: checkGenericPerIp (30/sec/IP) is appropriate — sign-out shouldn't need a dedicated limit.
>
> Tests:
> - Unit: missing Authorization header returns 401 (this is the one auth-required snippet endpoint); malformed token returns 200 (idempotent); valid token gets revoked; revoked token returns 200; cross-site token isn't revoked (site_id guard); CORS preflight
> - Integration: full chain magic-link → redeem → exchange → check (valid) → sign-out → check (returns valid:false)
>
> Once 5e lands, chunk 5 closes.

## Deliverable summary

### POST /v1/snippet/sign-out

Invariants enforced in order:

1. X-Site-Key → `resolveSite` → 403 `INVALID_SITE_KEY`
2. Origin → `applySnippetCors` → 403 `ORIGIN_NOT_ALLOWED` or 204 preflight
3. Rate limit → `checkGenericPerIp` (30/IP/sec) → 429
4. Authorization header absent → 401 `UNAUTHENTICATED` (the one auth-required snippet endpoint)
5. Malformed token (wrong prefix, too short, non-Bearer scheme) → 200 `{ signed_out: true }` — idempotent, no leak
6. Hash token, UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL AND site_id = site.id
7. Always 200 `{ data: { signed_out: true } }` — never reveals whether a session was actually revoked

## Files

- `packages/api/src/routes/snippet/sign-out.ts` — OPTIONS preflight + POST handler

## Tests

- 15 unit tests
- 11 integration tests
- All green

## Notable

- **Two layers of idempotency.** Missing Authorization returns 401 (this is structurally invalid). Malformed token returns 200 (this is functionally a sign-out — the user thinks they're signing out, and we don't reveal whether their token was real). Valid-but-already-revoked returns 200 (no information leak).
- **`site_id` predicate in the UPDATE.** A token from Site A presented to Site B's sign-out endpoint doesn't revoke anything. Defense in depth.

## Chunk 5 milestone

End User auth endpoints complete:

| Sub-chunk | Endpoint |
|---|---|
| 5a | POST /v1/snippet/magic-link/request |
| 5b | GET /v1/magic/redeem + /v1/magic/preflight |
| 5c | POST /v1/snippet/handoff/exchange |
| 5d | POST /v1/snippet/session/check |
| 5e | POST /v1/snippet/sign-out |

Full lifecycle covered: request magic link → email delivery → browser redemption → handoff exchange → session validation → sign-out. Integration tests verify the complete round-trip chain with a real Postgres container.

## Review notes

Major milestone. Backend half of the service is functionally complete. Auth-critical surfaces are locked. Every remaining chunk (snippet, dashboard, deploy) is wrapping, plumbing, and polish — important, but not architecturally risky.

## Next chunk

Chunk 6: `packages/snippet` — the browser snippet that customers embed. Three sub-chunks (6a, 6b, 6c). Opus on the iframe boundary work specifically.
