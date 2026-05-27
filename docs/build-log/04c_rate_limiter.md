# Chunk 4c: Rate limiter (Redis + Lua)

**Status:** ✅ Complete
**Model:** Sonnet 4.6
**Spec references:** `spec/07_rate_limiting.md`

## Prompt sent to Claude Code

> Chunk 4c: Rate limiter — Redis + Lua sliding-window script per spec/07_rate_limiting.md.
>
> Provision Railway Redis if not already there (use the railway CLI). Wire REDIS_URL into the api service's env.
>
> Build:
> - The Lua script as a string constant in api/src/services/rate-limit.ts (the canonical script from spec/07).
> - A `checkRateLimit(key, windowSec, limit)` function that loads the script on first use (SCRIPT LOAD + EVALSHA pattern, falling back to EVAL on NOSCRIPT).
> - Typed helpers for each named limit: `checkMagicLinkPerEmail(email)`, etc. — one per row in the spec/07 table. Each helper knows its own window, limit, and key prefix.
> - Response header helpers: `setRateLimitHeaders(reply, { limit, remaining, reset })`.
> - Unit tests against a testcontainer Redis confirming the sliding window actually slides.
>
> Do NOT wire the limiters into routes yet — that happens in chunk 5 when the routes exist. This chunk just builds the toolkit.
>
> The "silent rate limit" behavior for per-email magic-link limits is implemented in the route, not the limiter.

## Deliverable summary

`packages/api/src/services/rate-limit.ts`:

- `LUA_SCRIPT` — the canonical sorted-set sliding-window script from spec/07, verbatim.
- `checkRateLimit(key, windowSec, limit, redis?)` — core function; `SCRIPT LOAD` on first call, `EVALSHA` on every subsequent call, `NOSCRIPT` recovery with one reload+retry; bypasses instantly when `WH_DISABLE_RATE_LIMITS` is set.
- 9 typed helpers, one per spec/07 table row: `checkMagicLinkPerEmail`, `checkMagicLinkPerIp`, `checkMagicLinkPerSite`, `checkSessionCheckPerIp`, `checkOwnerLoginPerEmail`, `checkOwnerLoginPerIp`, `checkPasswordResetPerEmail`, `checkDomainVerifyPerSite`, `checkGenericPerIp` — each knows its own window, limit, and key prefix; emails are sha256-hashed, IPv6 keys on the /64 prefix.
- `setRateLimitHeaders(reply, {limit, remaining, reset, retryAfter?})` — emits `X-RateLimit-*` and `Retry-After` headers.

## Files

- `packages/api/src/services/rate-limit.ts`
- `packages/api/test/integration/rate-limit.test.ts`

## Tests

- 9 integration tests covering: allows up to limit, blocks at N+1, stays blocked, sliding window drains after expiry, N+1 across window boundary, key independence, correct limit field, NOSCRIPT recovery after `SCRIPT FLUSH`, and `resetAt` is a future unix timestamp.
- Uses testcontainers with a `redis:7-alpine` GenericContainer — requires Docker to run.
- Run with `pnpm --filter @wiredhowse/api test:integration` (excluded from default test to avoid breaking CI without Docker).

## Notable

- **Railway Redis provisioned** during this chunk. `REDIS_URL` now in the api service's env.
- **EVALSHA with NOSCRIPT recovery** — the production-grade pattern for Redis Lua scripts. Without recovery, a `SCRIPT FLUSH` on the Redis instance (e.g., during maintenance) would break the rate limiter until the api restarted.
- **Email sha256-hashed for key**, never plaintext. Prevents email enumeration via Redis key inspection.
- **IPv6 /64 prefix keying** — single IPv6 address allocations are typically /64 or larger, so keying on /128 (full address) is trivially evaded.

## Review notes

Production-grade. The 9 typed helpers turn a generic primitive into self-documenting code at every call site: `await checkMagicLinkPerIp(ip)` is unambiguous about which limit is being applied.

## Next chunk

Chunk 5: auth endpoints. Five sub-chunks (5a through 5e), Opus on 5b and 5c per model policy.
