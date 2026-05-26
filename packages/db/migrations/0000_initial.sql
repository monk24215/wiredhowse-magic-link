-- citext is used for case-insensitive email columns.
-- drizzle-kit does not track extensions, so this line is manually added.
CREATE EXTENSION IF NOT EXISTS "citext";
--> statement-breakpoint
CREATE TYPE "public"."site_owner_auth_method" AS ENUM('password', 'google', 'both');--> statement-breakpoint
CREATE TYPE "public"."site_state" AS ENUM('pending_verification', 'live', 'disabled');--> statement-breakpoint
CREATE TABLE "archived_end_users" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"email_hash" "bytea" NOT NULL,
	"original_user_id" text NOT NULL,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purge_after" timestamp with time zone NOT NULL,
	"session_summary" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_hash" "bytea"
);
--> statement-breakpoint
CREATE TABLE "email_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"site_owner_id" text NOT NULL,
	"email" "citext" NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "end_users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" "citext" NOT NULL,
	"email_verified_at" timestamp with time zone,
	"display_name" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "end_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "handoff_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "login_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"end_user_id" text NOT NULL,
	"site_id" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"session_id" text,
	"ip_hash" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "magic_links" (
	"id" text PRIMARY KEY NOT NULL,
	"email" "citext" NOT NULL,
	"site_id" text NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_at" timestamp with time zone,
	"requested_ip_hash" "bytea" NOT NULL,
	"requested_user_agent_hash" "bytea" NOT NULL,
	"redeemed_ip_hash" "bytea"
);
--> statement-breakpoint
CREATE TABLE "oauth_state" (
	"id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"return_to" text,
	CONSTRAINT "oauth_state_state_unique" UNIQUE("state")
);
--> statement-breakpoint
CREATE TABLE "password_resets" (
	"id" text PRIMARY KEY NOT NULL,
	"site_owner_id" text NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"end_user_id" text NOT NULL,
	"site_id" text NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"login_count_at_creation" integer NOT NULL,
	"ip_hash" "bytea" NOT NULL,
	"user_agent_hash" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_owner_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"site_owner_id" text NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip_hash" "bytea" NOT NULL,
	"user_agent_hash" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_owners" (
	"id" text PRIMARY KEY NOT NULL,
	"email" "citext" NOT NULL,
	"password_hash" text,
	"email_verified_at" timestamp with time zone,
	"google_sub" text,
	"auth_method" "site_owner_auth_method" DEFAULT 'password' NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	CONSTRAINT "site_owners_email_unique" UNIQUE("email"),
	CONSTRAINT "site_owners_google_sub_unique" UNIQUE("google_sub")
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" text PRIMARY KEY NOT NULL,
	"site_owner_id" text NOT NULL,
	"domain" text NOT NULL,
	"site_key" text NOT NULL,
	"state" "site_state" DEFAULT 'pending_verification' NOT NULL,
	"verification_token" text NOT NULL,
	"verification_method" text,
	"verified_at" timestamp with time zone,
	"allowed_origins" text[] DEFAULT '{}'::text[] NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sites_domain_unique" UNIQUE("domain"),
	CONSTRAINT "sites_site_key_unique" UNIQUE("site_key")
);
--> statement-breakpoint
ALTER TABLE "email_verifications" ADD CONSTRAINT "email_verifications_site_owner_id_site_owners_id_fk" FOREIGN KEY ("site_owner_id") REFERENCES "public"."site_owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoff_tokens" ADD CONSTRAINT "handoff_tokens_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_history" ADD CONSTRAINT "login_history_end_user_id_end_users_id_fk" FOREIGN KEY ("end_user_id") REFERENCES "public"."end_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_history" ADD CONSTRAINT "login_history_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_history" ADD CONSTRAINT "login_history_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "magic_links" ADD CONSTRAINT "magic_links_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_site_owner_id_site_owners_id_fk" FOREIGN KEY ("site_owner_id") REFERENCES "public"."site_owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_end_user_id_end_users_id_fk" FOREIGN KEY ("end_user_id") REFERENCES "public"."end_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_owner_sessions" ADD CONSTRAINT "site_owner_sessions_site_owner_id_site_owners_id_fk" FOREIGN KEY ("site_owner_id") REFERENCES "public"."site_owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_site_owner_id_site_owners_id_fk" FOREIGN KEY ("site_owner_id") REFERENCES "public"."site_owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_archived_purge" ON "archived_end_users" USING btree ("purge_after");--> statement-breakpoint
CREATE INDEX "idx_audit_log_actor" ON "audit_log" USING btree ("actor_type","actor_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_audit_log_action_time" ON "audit_log" USING btree ("action","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_email_verifications_token_hash" ON "email_verifications" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_handoff_tokens_token_hash" ON "handoff_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_login_history_user_site" ON "login_history" USING btree ("end_user_id","site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_magic_links_token_hash" ON "magic_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_magic_links_expires_at" ON "magic_links" USING btree ("expires_at") WHERE "redeemed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_magic_links_email_site" ON "magic_links" USING btree ("email","site_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_password_resets_token_hash" ON "password_resets" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sessions_token_hash" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_sessions_end_user_site" ON "sessions" USING btree ("end_user_id","site_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_expires_at" ON "sessions" USING btree ("expires_at") WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_site_owner_sessions_token_hash" ON "site_owner_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_site_owners_google_sub" ON "site_owners" USING btree ("google_sub") WHERE "google_sub" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_sites_site_owner_id" ON "sites" USING btree ("site_owner_id");--> statement-breakpoint
CREATE INDEX "idx_sites_site_key" ON "sites" USING btree ("site_key");
