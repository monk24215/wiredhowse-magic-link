# Chunk 8: Cron service (cleanup + archive purge)

**Status:** ✅ Complete
**Model:** Sonnet 4.6
**Spec references:** `spec/06_session_token_design.md`, `spec/09_railway_layout.md`

## Prompt sent to Claude Code

> Chunk 8: Cron service per spec/09_railway_layout.md.
>
> Sonnet 4.6.
>
> Build a separate service in the repo that runs scheduled jobs. It reuses code from `packages/api` (Drizzle client, schema, services) so duplication is minimal.
>
> Structure:
> - New entry point at `packages/api/src/cron.ts` (or `packages/cron/` as its own package if cleaner — your call). The job runner shares dependencies with the api but has its own entry point.
> - Use node-cron or a similar scheduler. Lightweight, no external scheduler service.
> - All jobs log structured JSON to stdout (same logger as api) with job name, duration, rows affected, errors.
>
> Jobs:
>
> **Hourly:** magic_links > 24h, handoff_tokens > 1h, oauth_state > 1h, email_verifications expires_at past 7d, password_resets expires_at past 7d
>
> **Daily at 02:00 UTC:** sessions expires_at past 7d (cascades), archived_end_users where purge_after < now() (GDPR 24-month purge)
>
> **Daily at 03:00 UTC:** audit_log older than retention (configurable env var, default 90 days)
>
> Reliability requirements: each job wraps in try/catch (one failure doesn't kill others), atomic per table, idempotent, structured logs.
>
> Manual run capability: `pnpm --filter cron run-once <job-name>` for ad-hoc cleanup or testing.

## Deliverable summary

8 cleanup/purge jobs shipped as a standalone Railway service alongside the API.

### Jobs

| Schedule | Job | Deletes |
|---|---|---|
| Hourly | `cleanupMagicLinks` | `magic_links > 24h` old |
| Hourly | `cleanupHandoffTokens` | `handoff_tokens > 1h` old (clears raw session token) |
| Hourly | `cleanupOauthState` | `oauth_state > 1h` old |
| Hourly | `cleanupEmailVerifications` | `email_verifications` where `expires_at > 7d` past |
| Hourly | `cleanupPasswordResets` | `password_resets` where `expires_at > 7d` past |
| Daily 02:00 UTC | `cleanupExpiredSessions` | `sessions` where `expires_at > 7d` past (cascades to login_history) |
| Daily 02:00 UTC | `purgeArchivedEndUsers` | `archived_end_users` where `purge_after < now()` (GDPR 24-month) |
| Daily 03:00 UTC | `cleanupAuditLog` | `audit_log` older than `AUDIT_LOG_RETENTION_DAYS` (default 90) |

## Files

- `src/cron.ts` — entry point, Fastify health check on `:3002`, graceful shutdown
- `src/cron/scheduler.ts` — node-cron wiring, 3 schedule groups
- `src/cron/jobs/` — one file per job, each wraps in try/catch
- `src/cron-run-once.ts` — `pnpm --filter @wiredhowse/api run-once <jobName>`
- `Dockerfile.cron` — Railway cron service image (`CMD ["node", "dist/cron.js"]`)

## Tests

- 36 unit tests with mock DB, all pass
- Integration tests via testcontainers: seed stale + fresh rows, verify exact deletion counts and idempotency

## Notable

- **CTE delete-with-count pattern.** `WITH deleted AS (DELETE ... RETURNING 1) SELECT count(*)` — single round-trip, no memory load regardless of row count. Avoids the naive two-step `DELETE` + `SELECT count` which is racy.
- **`make_interval(days => $1)`** for the audit log retention parameter. Parameterized, no SQL injection surface even though the input is a trusted env var. Defense in depth as a default habit.
- **Sequential execution with per-job try/catch.** One failing job never kills the group. The handoff cleanup throwing doesn't prevent the magic-links cleanup from running. Worst case: one stuck job logged for ops attention, no cascading failure.
- **Health check at `:3002`** for Railway to monitor the cron service independently of the api.
- **Graceful shutdown** on SIGTERM — drains in-flight job before exiting. Railway redeploys won't interrupt a running cleanup mid-transaction.
- **`cron-run-once` CLI** for ad-hoc invocation. Future ops fix-it tool when something needs manual cleanup outside the schedule.

## Review notes

Production-grade execution. The CTE pattern and the parameterized interval syntax are both signs of genuine engagement with the SQL surface, not just translation of the prompt. The decision to put the cron entry point inside `packages/api/` (rather than spawning `packages/cron/`) keeps deployment simpler — same image base, same dependencies, just a different start command.

## Next chunk

9: Railway deploy + DNS + DMARC ramp. The final chunk. Service goes from "shippable" to "shipped." Mostly operational work: configure custom domain, run Resend onboarding, set DMARC at p=none, smoke-test mail to gmail/outlook/yahoo, verify the full magic-link flow against a real demo Site. Postgres minor upgrade (18.4) can happen in this chunk's pre-launch testing window.
