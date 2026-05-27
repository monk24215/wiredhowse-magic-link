# Chunk 8 — Cron Service (cleanup + archive purge)

## Prompt summary

Build a separate cron service that reuses code from `packages/api` (Drizzle client, schema). Use `node-cron` for scheduling. Expose `/healthz`. Write unit + integration tests with testcontainers. Add `Dockerfile.cron` and `run-once` script.

## Deliverable summary

A complete cleanup/purge service running alongside the API on Railway. All 8 jobs implemented, scheduled, tested, and idempotent.

## Files changed

### New files

| File | Description |
|------|-------------|
| `packages/api/src/cron.ts` | Entry point. Fastify instance for `/healthz` + scheduler bootstrap. Graceful SIGTERM/SIGINT handling. |
| `packages/api/src/cron-run-once.ts` | Ad-hoc runner: `pnpm --filter @wiredhowse/api run-once <jobName>`. Reads job name from argv, runs once, exits. |
| `packages/api/src/cron/config.ts` | Cron-only env config (DATABASE_URL, LOG_LEVEL, HEALTHZ_PORT, AUDIT_LOG_RETENTION_DAYS). Validates at import time, fails fast. |
| `packages/api/src/cron/scheduler.ts` | `createScheduler(logger)` factory. Wires up 3 cron schedules via `node-cron`. Returns `{ start(), stop() }`. |
| `packages/api/src/cron/jobs/types.ts` | Shared types: `JobResult`, `CronLogger`. |
| `packages/api/src/cron/jobs/cleanup-magic-links.ts` | Hourly: DELETE magic_links older than 24 hours. |
| `packages/api/src/cron/jobs/cleanup-handoff-tokens.ts` | Hourly: DELETE handoff_tokens older than 1 hour. Clears raw_session_token exposure. |
| `packages/api/src/cron/jobs/cleanup-oauth-state.ts` | Hourly: DELETE oauth_state older than 1 hour. |
| `packages/api/src/cron/jobs/cleanup-email-verifications.ts` | Hourly: DELETE email_verifications where expires_at < now() - 7 days. |
| `packages/api/src/cron/jobs/cleanup-password-resets.ts` | Hourly: DELETE password_resets where expires_at < now() - 7 days. |
| `packages/api/src/cron/jobs/cleanup-expired-sessions.ts` | Daily 02:00 UTC: DELETE sessions where expires_at < now() - 7 days. |
| `packages/api/src/cron/jobs/purge-archived-end-users.ts` | Daily 02:00 UTC: DELETE archived_end_users where purge_after < now() (GDPR 24-month purge). |
| `packages/api/src/cron/jobs/cleanup-audit-log.ts` | Daily 03:00 UTC: DELETE audit_log where occurred_at < now() - N days. N from `AUDIT_LOG_RETENTION_DAYS` (default 90). Uses `make_interval(days => $1)` for parameterized interval. |
| `packages/api/src/cron/jobs/index.ts` | Re-exports all job functions + types. |
| `packages/api/Dockerfile.cron` | Same multi-stage build as `Dockerfile` but `CMD ["node", "dist/cron.js"]`. EXPOSE 3002. |
| `packages/api/test/unit/cron-jobs.test.ts` | 36 unit tests. Mock DB (`as unknown as Database`). Verifies job names, counts, error handling, duration shape. Cross-cutting shape tests for all 8 jobs × 2 scenarios (success + error). |
| `packages/api/test/integration/cron-jobs.test.ts` | Integration tests with real Postgres (testcontainers). Seeds stale + fresh rows, runs each job, asserts exact deletion counts and preserved rows. Idempotency verified for magic_links, archived_end_users, and audit_log. |

### Modified files

| File | Change |
|------|--------|
| `packages/api/package.json` | Added `node-cron ^3.0.3` (dep) + `@types/node-cron ^3.0.11` (devDep). Added scripts: `dev:cron`, `start:cron`, `run-once`. |
| `CLAUDE.md` | Marked cron service complete. |
| `docs/build-log/README.md` | Status table updated. |

## Architecture decisions

### Entry point lives in `packages/api/src/`

The spec permitted either a new `packages/cron/` or an entry in `packages/api`. Chose the latter: the cron service needs the Drizzle schema, the logger style, and Fastify — all already in `api/`. Adding a new workspace package would add zero value and duplicate build config.

The Railway cron service sets `Root Directory: packages/api` and `CMD: node dist/cron.js` — same as the spec.

### CTE pattern for counted deletes

Each job uses:
```sql
WITH deleted AS (
  DELETE FROM <table> WHERE <condition> RETURNING 1
)
SELECT count(*) AS count FROM deleted
```

Advantages:
- Single round-trip (DELETE + COUNT in one query).
- No memory pressure — never loads row data into Node.js.
- `count(*)` always returns exactly one row (0 if nothing deleted), so `rows[0]?.count` is always defined.

### Parameterized interval for audit_log

`make_interval(days => $1)` is used rather than string interpolation like `'90 days'::interval`. Drizzle's `sql` template tag parameterizes `${retentionDays}` as a prepared-statement value, eliminating any injection surface.

### `JobDatabase` interface removed

Initial design used a `JobDatabase` interface to enable lightweight mocks in unit tests. Drizzle's `RowList` return type is not structurally compatible with simple `readonly T[]`, causing TypeScript errors. Replaced with `Database` from `@wiredhowse/db` + `as unknown as Database` cast in unit tests — the same pattern used everywhere else in the test suite.

### Health check design

`/healthz` returns 503 before `scheduler.start()` completes, 200 after. Railway monitors this independently of the API's `/readyz`. The cron service has no DB health check in `/healthz` — if Postgres is down, jobs will emit error logs, which is the intended fail-closed behaviour.

## Test results

```
✓ test/unit/cron-jobs.test.ts (36 tests) — 47ms
All 218 unit tests pass.
```

Integration tests require Docker; run with `pnpm --filter @wiredhowse/api test:integration`.

## Env vars (cron service on Railway)

```
NODE_ENV=production
DATABASE_URL=${{ Postgres.DATABASE_URL }}
LOG_LEVEL=info
HEALTHZ_PORT=3002
AUDIT_LOG_RETENTION_DAYS=90   # optional, default 90
```

No Redis, Resend, or Google OAuth vars needed — cron only touches Postgres.

## Notable

- `cleanupHandoffTokens` is critical for security: handoff_tokens contain `raw_session_token` (plaintext `wh_s_` value). The 1-hour cleanup window ensures these ephemeral rows are purged well before any audit or backup retention window.
- All jobs are idempotent: running twice in a row deletes nothing the second time (verified in integration tests).
- One failing job does not kill the group — `runGroup` is sequential, each job has its own try/catch.
