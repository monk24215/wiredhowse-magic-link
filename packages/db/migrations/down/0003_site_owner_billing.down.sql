ALTER TABLE "site_owners" DROP CONSTRAINT IF EXISTS "site_owners_stripe_subscription_id_unique";
ALTER TABLE "site_owners" DROP CONSTRAINT IF EXISTS "site_owners_stripe_customer_id_unique";
ALTER TABLE "site_owners" DROP COLUMN "stripe_subscription_id";
ALTER TABLE "site_owners" DROP COLUMN "stripe_customer_id";
ALTER TABLE "site_owners" DROP COLUMN "plan_period_end";
ALTER TABLE "site_owners" DROP COLUMN "plan_status";
ALTER TABLE "site_owners" DROP COLUMN "plan";
DROP TYPE IF EXISTS "site_owner_plan";
