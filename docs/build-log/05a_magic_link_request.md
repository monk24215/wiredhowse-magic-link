# Chunk 5a: POST /v1/snippet/magic-link/request

**Status:** ✅ Complete
**Model:** Sonnet 4.6
**Spec references:** `spec/02_api_surface.md`, `spec/03_auth_flows.md`, `spec/07_rate_limiting.md`

## Prompt sent to Claude Code

(Excerpt from chunk 5 intro prompt)

> 5a: POST /v1/snippet/magic-link/request — validates site key + origin, rate limits in the correct order (IP → site → email, with silent 200 for email-rate-limited), creates magic_links row, sends email via the Resend wrapper.
>
> Every route uses the X-Site-Key header + Origin allowlist enforcement from the cors middleware. Every route emits X-Request-Id. Every route uses the rate-limit helpers from chunk 4c. Every token write is hashed (never store raw).

## Deliverable summary

Handler flow:

1. Resolves site from `X-Site-Key` header via `resolveSite()` helper (shared by POST + OPTIONS handlers)
2. CORS/origin enforcement via `applySnippetCors`
3. Guards `site.state === 'live'` → 403 `SITE_DISABLED`
4. Zod validates `{ email }` body
5. Rate limits in spec order — IP → site → email; only email limit is silent (returns 200 to prevent enumeration)
6. Inserts `magic_links` row with hashed token, IP, UA
7. Fires email non-blocking (errors logged, not propagated)
8. Always returns `{ data: { sent: true, expires_in_seconds: 900 } }`

## Files

- `packages/api/src/routes/snippet/magic-link-request.ts` — POST + OPTIONS handlers
- `packages/api/src/index.ts` — adds `genReqId: () => 'req_<12-char base64url>'` and a global `onSend` hook that emits `X-Request-Id` on every response
- `packages/api/test/unit/magic-link-request.test.ts`

## Tests

- 15 unit tests: happy path, DB insert + email call, rate limit order enforcement, silent email rate limit, site-disabled guard, origin guard, validation, OPTIONS preflight. All passing.

## Notable

- **Rate-limit ordering is load-bearing.** IP limit hits → 429 immediately; site limit hits → 429; email limit hits → silent 200. If a malicious actor could trigger the email-level limit without hitting IP/site limits first, they could enumerate emails. Order prevents this.
- **Email send is fire-and-forget.** Errors logged but don't fail the request. User experience stays consistent regardless of Resend availability — the rate-limit consumed slot is the user-visible artifact.
- **`X-Request-Id` global hook** — every response now has a correlation ID for log lookup.

## Review notes

The email send being fire-and-forget needs to fail loudly inside its own scope. If `getResend()` throws synchronously due to misconfiguration, the response goes out before the error propagates. Verify the wrapper catches all sync errors. Noted for chunk 5b context.

## Next chunk

5b: `/v1/magic/redeem` + `/v1/magic/preflight`. Auth-critical surface — switch to Opus 4.7.
