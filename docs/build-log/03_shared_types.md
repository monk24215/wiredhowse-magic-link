# Chunk 3: `packages/shared` types

**Status:** ✅ Complete
**Model:** Sonnet 4.6
**Spec references:** `spec/02_api_surface.md`

## Prompt sent to Claude Code

> continue with chunk 3: packages/shared types

## Deliverable summary

Complete rewrite of `packages/shared` covering every endpoint in the spec.

- **`api-types.ts`** — `ApiSuccess<T>` / `ApiErrorBody` envelope, every snippet/auth/dashboard/me/identity request and response type. Field names are snake_case to match JSON examples in the spec.
- **`errors.ts`** — full error code set: `HANDOFF_NOT_FOUND`, `SITE_MISMATCH`, `INVALID_SITE_KEY`, `UNAUTHENTICATED`, `ACCOUNT_LOCKED`, `INVALID_CREDENTIALS`, `EMAIL_NOT_VERIFIED`, `SITE_LIMIT_REACHED`, `DOMAIN_ALREADY_REGISTERED`, `INVALID_CONFIRMATION`.
- **`zod-schemas.ts`** — request body validators across snippet, auth, and dashboard. Password validation enforced at 8–128 chars. Close-and-archive confirmation is `z.literal('DELETE MY DATA')`.

## Files

- `packages/shared/src/api-types.ts`
- `packages/shared/src/errors.ts`
- `packages/shared/src/zod-schemas.ts`
- `packages/shared/src/index.ts` (re-exports)

## Tests

- Typecheck-only at this layer. Behavior tested by every consumer (api, web, snippet).

## Notable

- **`siteKey` removed from request bodies** — it's an `X-Site-Key` header, not a body field. Matches the spec; avoids accidental duplication.
- Field naming: snake_case in JSON, camelCase in TS internals, with `api-types.ts` as the boundary.

## Review notes

Single source of truth for API shapes. Every downstream package imports from `@wiredhowse/shared` instead of redefining. Pays compounding dividends — when an endpoint changes shape, exactly one file changes, and TypeScript surfaces every consumer that needs to update.

## Next chunk

Chunk 4: `packages/api` skeleton + Resend wrapper + rate limiter. Will be split into 4a (skeleton + middleware), 4b (email), 4c (rate limiter).
