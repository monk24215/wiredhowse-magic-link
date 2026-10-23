-- 0003: Plan and Stripe billing state on site_owners.
-- Additive only. Constant default keeps the NOT NULL add metadata-only (PG11+).
-- Existing rows become plan = 'free'. See docs/migrations/0003_site_owner_billing.md.

CREATE TYPE "site_owner_plan" AS ENUM ('free', 'pro');
--> statement-breakpoint
ALTER TABLE "site_owners" ADD COLUMN "plan" "site_owner_plan" NOT NULL DEFAULT 'free';
--> statement-breakpoint
ALTER TABLE "site_owners" ADD COLUMN "plan_status" text;
--> statement-breakpoint
ALTER TABLE "site_owners" ADD COLUMN "plan_period_end" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "site_owners" ADD COLUMN "stripe_customer_id" text;
--> statement-breakpoint
ALTER TABLE "site_owners" ADD COLUMN "stripe_subscription_id" text;
--> statement-breakpoint
ALTER TABLE "site_owners" ADD CONSTRAINT "site_owners_stripe_customer_id_unique" UNIQUE ("stripe_customer_id");
--> statement-breakpoint
ALTER TABLE "site_owners" ADD CONSTRAINT "site_owners_stripe_subscription_id_unique" UNIQUE ("stripe_subscription_id");
