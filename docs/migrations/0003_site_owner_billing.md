# Migration 0003 — site_owner billing columns

## Purpose
Add plan state to `site_owners` so the Stripe subscription webhook can set a
Site Owner's plan (`free` | `pro`) and the API can enforce tier limits.

## Change (additive only)
| Column | Type | Null | Default |
|---|---|---|---|
| `plan` | enum `site_owner_plan` (`free`, `pro`) | NOT NULL | `'free'` |
| `plan_status` | text | NULL | NULL |
| `plan_period_end` | timestamptz | NULL | NULL |
| `stripe_customer_id` | text, unique | NULL | NULL |
| `stripe_subscription_id` | text, unique | NULL | NULL |

`plan_status` mirrors Stripe subscription status (`active`, `past_due`, `canceled`).

## Lock / rewrite risk
- Constant default on a NOT NULL column: metadata-only on Postgres 11+ (Railway runs 16). No table rewrite.
- Nullable columns and unique indexes on NULL-heavy columns: no rewrite. Unique index build takes a brief lock on an empty-ish table; acceptable at current size. Create indexes CONCURRENTLY if the table is large at deploy time.

## Backfill
None required. Every existing row gets `plan = 'free'` via the default, which matches current behavior (3-site cap for everyone).

## Compatibility
- Old code ignores the new columns, so the migration can deploy before the app change.
- Rollback: run `down/0003_site_owner_billing.down.sql`. Safe only before any paid row exists; otherwise export `stripe_*` columns first.

## Tier enforcement (app layer, not schema)
- Free: 3 sites, up to 500 monthly active End Users (distinct `sessions.end_user_id` with `created_at` in last 30 days, per owner).
- Pro: 10 sites, up to 10,000 monthly active End Users. Flat monthly price set in Stripe.
- Enforced in `routes/dashboard/sites.ts` (site cap, replaces `SITE_LIMIT = 3` with a plan lookup) and in magic-link request (MAU cap, returns the existing non-enumerating 200 response when over cap is NOT used; over-cap returns 429 with `PLAN_LIMIT_REACHED`).

## Verification
1. `pnpm -F @wiredhowse/db typecheck`
2. Apply up on a fresh Postgres 16 testcontainer; apply down; apply up again.
3. Existing integration tests pass unchanged.

## Sign-off required
Per CLAUDE.md, schema changes after first prod deploy need this plan first. Plan is recorded here; apply to prod only after review.
