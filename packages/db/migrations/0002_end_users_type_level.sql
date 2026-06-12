-- 0002: Add type_value and level_value to end_users.
--
-- type_value: user classification. 10 = visitor (default), 30 = member.
--   Values are integers so future types slot in without a schema change.
--
-- level_value: access/trust level. 10 = Yellow (lowest), 70 = White (highest).
--   Intermediate values are reserved for future tiers.
--
-- Both columns carry a permanent DEFAULT so this is a metadata-only operation
-- in Postgres 11+ — no table rewrite, no row lock beyond the DDL itself.
-- Existing rows silently get 10/10.

ALTER TABLE "end_users" ADD COLUMN "type_value" integer NOT NULL DEFAULT 10;
--> statement-breakpoint
ALTER TABLE "end_users" ADD COLUMN "level_value" integer NOT NULL DEFAULT 10;
