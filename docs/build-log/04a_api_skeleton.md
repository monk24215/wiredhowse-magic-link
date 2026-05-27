# Chunk 4a: api skeleton + middleware

**Status:** ✅ Complete
**Model:** Sonnet 4.6
**Spec references:** `spec/02_api_surface.md`, `spec/09_railway_layout.md`

## Prompt sent to Claude Code

> Continue with chunk 4: packages/api skeleton with health/readiness + Resend wrapper + rate limiter.
>
> This chunk is large — three substantial pieces. Break it into sub-chunks and stop between each so I can /clear:
>
> - 4a: api skeleton + middleware (cors, auth, logging, error handling) + config + structured error responses
> - 4b: Resend wrapper + email templates (magic link, email verification, password reset)
> - 4c: Rate limiter — Redis + the Lua sliding-window script from spec/07
>
> Provision Railway Redis when 4c needs it, same path as Postgres. Health/readiness checks already exist from chunk 1 — extend them to actually verify Postgres SELECT 1 and Redis PING per the spec, not just return 200.
>
> Start with 4a.

## Deliverable summary

Full middleware + lib + crypto foundation. Real health checks wired to Postgres + Redis with 500ms deadlines.

## Files

| File | Purpose |
|---|---|
| `lib/crypto.ts` | `generateToken`, `hashToken` (→ Buffer for bytea), `timingSafeCompare` |
| `lib/hashing.ts` | `hashForLog` (truncated sha256 for PII-safe logs), `hashBytes` |
| `lib/time.ts` | `nowUtc`, `addSeconds`, `isPast` |
| `lib/redis.ts` | ioredis singleton with lazy connect, `pingRedis` with 500ms timeout |
| `middleware/cors.ts` | `applySnippetCors()` for snippet route CORS + preflight |
| `middleware/logging.ts` | Request logging hook, emits hashed IP |
| `middleware/auth-session.ts` | `requireEndUserSession` preHandler |
| `middleware/auth-owner.ts` | `requireSiteOwnerSession` preHandler with manual cookie parser |
| `routes/health.ts` | Real `SELECT 1` + Redis `PING` with 500ms deadline. Routes are `/healthz` and `/readyz` (top-level, no `/v1` prefix) |
| `errors.ts` | `{ error: { code, message } }` envelope; global 404 + error handler |
| `index.ts` | Registers `@fastify/helmet`, global handler, logging; `trustProxy: true` for Railway |

## Tests

- Unit tests for crypto helpers and middleware. Health checks tested in integration.

## Notable

- **`/healthz` and `/readyz` top-level, not under `/v1`** — infrastructure endpoints should never be versioned.
- **`trustProxy: true`** — Railway sits behind a proxy that sets `X-Forwarded-For`. Without this, IP-based rate limiting would see the proxy's IP for every request.
- **`drizzle-orm` added as a direct dep** for query operators; previously only used transitively through `@wiredhowse/db`.

## Review notes

`timingSafeCompare` is included in the crypto lib but isn't strictly needed for opaque tokens — SQL equality on indexed bytea is the actual comparison path. Useful later for password-related comparisons. Not a problem to have it available.

Watch for: pino's default serializers can leak email addresses if request bodies are auto-logged. Worth a lint rule or CI grep-check before email-handling endpoints land in chunk 5.

## Next chunk

4b: Resend wrapper + three email templates.
