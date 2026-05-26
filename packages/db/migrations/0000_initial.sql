-- Enable citext for case-insensitive email storage
CREATE EXTENSION IF NOT EXISTS "citext";
--> statement-breakpoint

-- ── Enums ───────────────────────────────────────────────────────────────────
CREATE TYPE "public"."site_state" AS ENUM (
  'pending_verification',
  'live',
  'disabled'
);
--> statement-breakpoint
CREATE TYPE "public"."site_owner_auth_method" AS ENUM (
  'password',
  'google',
  'both'
);
--> statement-breakpoint

-- ── site_owners ─────────────────────────────────────────────────────────────
CREATE TABLE "site_owners" (
  "id"                 text PRIMARY KEY NOT NULL,
  "email"              citext NOT NULL,
  "password_hash"      text,
  "email_verified_at"  timestamptz,
  "google_sub"         text,
  "auth_method"        "site_owner_auth_method" NOT NULL DEFAULT 'password',
  "display_name"       text,
  "created_at"         timestamptz NOT NULL DEFAULT now(),
  "last_login_at"      timestamptz,
  "failed_login_count" integer NOT NULL DEFAULT 0,
  "locked_until"       timestamptz
);
--> statement-breakpoint
ALTER TABLE "site_owners" ADD CONSTRAINT "site_owners_email_unique" UNIQUE ("email");
--> statement-breakpoint
ALTER TABLE "site_owners" ADD CONSTRAINT "site_owners_google_sub_unique" UNIQUE ("google_sub");
--> statement-breakpoint
CREATE INDEX "idx_site_owners_google_sub" ON "site_owners" ("google_sub") WHERE "google_sub" IS NOT NULL;
--> statement-breakpoint

-- ── sites ───────────────────────────────────────────────────────────────────
CREATE TABLE "sites" (
  "id"                   text PRIMARY KEY NOT NULL,
  "site_owner_id"        text NOT NULL,
  "domain"               text NOT NULL,
  "site_key"             text NOT NULL,
  "state"                "site_state" NOT NULL DEFAULT 'pending_verification',
  "verification_token"   text NOT NULL,
  "verification_method"  text,
  "verified_at"          timestamptz,
  "allowed_origins"      text[] NOT NULL DEFAULT '{}',
  "disabled_at"          timestamptz,
  "created_at"           timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_domain_unique" UNIQUE ("domain");
--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_site_key_unique" UNIQUE ("site_key");
--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_site_owner_id_fk"
  FOREIGN KEY ("site_owner_id") REFERENCES "site_owners"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX "idx_sites_site_owner_id" ON "sites" ("site_owner_id");
--> statement-breakpoint
CREATE INDEX "idx_sites_site_key" ON "sites" ("site_key");
--> statement-breakpoint

-- ── end_users ───────────────────────────────────────────────────────────────
CREATE TABLE "end_users" (
  "id"               text PRIMARY KEY NOT NULL,
  "email"            citext NOT NULL,
  "email_verified_at" timestamptz,
  "display_name"     text,
  "metadata"         jsonb NOT NULL DEFAULT '{}',
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "last_seen_at"     timestamptz
);
--> statement-breakpoint
ALTER TABLE "end_users" ADD CONSTRAINT "end_users_email_unique" UNIQUE ("email");
--> statement-breakpoint

-- ── sessions ────────────────────────────────────────────────────────────────
CREATE TABLE "sessions" (
  "id"                     text PRIMARY KEY NOT NULL,
  "end_user_id"            text NOT NULL,
  "site_id"                text NOT NULL,
  "token_hash"             bytea NOT NULL,
  "created_at"             timestamptz NOT NULL DEFAULT now(),
  "expires_at"             timestamptz NOT NULL,
  "last_used_at"           timestamptz NOT NULL DEFAULT now(),
  "revoked_at"             timestamptz,
  "login_count_at_creation" integer NOT NULL,
  "ip_hash"                bytea NOT NULL,
  "user_agent_hash"        bytea NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_end_user_id_fk"
  FOREIGN KEY ("end_user_id") REFERENCES "end_users"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_site_id_fk"
  FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sessions_token_hash" ON "sessions" ("token_hash");
--> statement-breakpoint
CREATE INDEX "idx_sessions_end_user_site" ON "sessions" ("end_user_id", "site_id");
--> statement-breakpoint
CREATE INDEX "idx_sessions_expires_at" ON "sessions" ("expires_at") WHERE "revoked_at" IS NULL;
--> statement-breakpoint

-- ── magic_links ─────────────────────────────────────────────────────────────
CREATE TABLE "magic_links" (
  "id"                         text PRIMARY KEY NOT NULL,
  "email"                      citext NOT NULL,
  "site_id"                    text NOT NULL,
  "token_hash"                 bytea NOT NULL,
  "created_at"                 timestamptz NOT NULL DEFAULT now(),
  "expires_at"                 timestamptz NOT NULL,
  "redeemed_at"                timestamptz,
  "requested_ip_hash"          bytea NOT NULL,
  "requested_user_agent_hash"  bytea NOT NULL,
  "redeemed_ip_hash"           bytea
);
--> statement-breakpoint
ALTER TABLE "magic_links" ADD CONSTRAINT "magic_links_site_id_fk"
  FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_magic_links_token_hash" ON "magic_links" ("token_hash");
--> statement-breakpoint
CREATE INDEX "idx_magic_links_expires_at" ON "magic_links" ("expires_at") WHERE "redeemed_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "idx_magic_links_email_site" ON "magic_links" ("email", "site_id", "created_at" DESC);
--> statement-breakpoint

-- ── handoff_tokens ──────────────────────────────────────────────────────────
CREATE TABLE "handoff_tokens" (
  "id"          text PRIMARY KEY NOT NULL,
  "session_id"  text NOT NULL,
  "token_hash"  bytea NOT NULL,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "expires_at"  timestamptz NOT NULL,
  "redeemed_at" timestamptz
);
--> statement-breakpoint
ALTER TABLE "handoff_tokens" ADD CONSTRAINT "handoff_tokens_session_id_fk"
  FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_handoff_tokens_token_hash" ON "handoff_tokens" ("token_hash");
--> statement-breakpoint

-- ── login_history ───────────────────────────────────────────────────────────
CREATE TABLE "login_history" (
  "id"          bigserial PRIMARY KEY NOT NULL,
  "end_user_id" text NOT NULL,
  "site_id"     text NOT NULL,
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  "session_id"  text,
  "ip_hash"     bytea NOT NULL
);
--> statement-breakpoint
ALTER TABLE "login_history" ADD CONSTRAINT "login_history_end_user_id_fk"
  FOREIGN KEY ("end_user_id") REFERENCES "end_users"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "login_history" ADD CONSTRAINT "login_history_site_id_fk"
  FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "login_history" ADD CONSTRAINT "login_history_session_id_fk"
  FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "idx_login_history_user_site" ON "login_history" ("end_user_id", "site_id");
--> statement-breakpoint

-- ── archived_end_users ──────────────────────────────────────────────────────
CREATE TABLE "archived_end_users" (
  "id"               bigserial PRIMARY KEY NOT NULL,
  "email_hash"       bytea NOT NULL,
  "original_user_id" text NOT NULL,
  "archived_at"      timestamptz NOT NULL DEFAULT now(),
  "purge_after"      timestamptz NOT NULL,
  "session_summary"  jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_archived_purge" ON "archived_end_users" ("purge_after");
--> statement-breakpoint

-- ── site_owner_sessions ─────────────────────────────────────────────────────
CREATE TABLE "site_owner_sessions" (
  "id"             text PRIMARY KEY NOT NULL,
  "site_owner_id"  text NOT NULL,
  "token_hash"     bytea NOT NULL,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "expires_at"     timestamptz NOT NULL,
  "last_used_at"   timestamptz NOT NULL DEFAULT now(),
  "revoked_at"     timestamptz,
  "ip_hash"        bytea NOT NULL,
  "user_agent_hash" bytea NOT NULL
);
--> statement-breakpoint
ALTER TABLE "site_owner_sessions" ADD CONSTRAINT "site_owner_sessions_site_owner_id_fk"
  FOREIGN KEY ("site_owner_id") REFERENCES "site_owners"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_site_owner_sessions_token_hash" ON "site_owner_sessions" ("token_hash");
--> statement-breakpoint

-- ── email_verifications ─────────────────────────────────────────────────────
CREATE TABLE "email_verifications" (
  "id"             text PRIMARY KEY NOT NULL,
  "site_owner_id"  text NOT NULL,
  "email"          citext NOT NULL,
  "token_hash"     bytea NOT NULL,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "expires_at"     timestamptz NOT NULL,
  "verified_at"    timestamptz
);
--> statement-breakpoint
ALTER TABLE "email_verifications" ADD CONSTRAINT "email_verifications_site_owner_id_fk"
  FOREIGN KEY ("site_owner_id") REFERENCES "site_owners"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_email_verifications_token_hash" ON "email_verifications" ("token_hash");
--> statement-breakpoint

-- ── password_resets ─────────────────────────────────────────────────────────
CREATE TABLE "password_resets" (
  "id"             text PRIMARY KEY NOT NULL,
  "site_owner_id"  text NOT NULL,
  "token_hash"     bytea NOT NULL,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "expires_at"     timestamptz NOT NULL,
  "used_at"        timestamptz
);
--> statement-breakpoint
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_site_owner_id_fk"
  FOREIGN KEY ("site_owner_id") REFERENCES "site_owners"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_password_resets_token_hash" ON "password_resets" ("token_hash");
--> statement-breakpoint

-- ── oauth_state ─────────────────────────────────────────────────────────────
CREATE TABLE "oauth_state" (
  "id"          text PRIMARY KEY NOT NULL,
  "state"       text NOT NULL,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "expires_at"  timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "return_to"   text
);
--> statement-breakpoint
ALTER TABLE "oauth_state" ADD CONSTRAINT "oauth_state_state_unique" UNIQUE ("state");
--> statement-breakpoint

-- ── audit_log ───────────────────────────────────────────────────────────────
CREATE TABLE "audit_log" (
  "id"          bigserial PRIMARY KEY NOT NULL,
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  "actor_type"  text NOT NULL,
  "actor_id"    text,
  "action"      text NOT NULL,
  "target_type" text,
  "target_id"   text,
  "metadata"    jsonb NOT NULL DEFAULT '{}',
  "ip_hash"     bytea
);
--> statement-breakpoint
CREATE INDEX "idx_audit_log_actor" ON "audit_log" ("actor_type", "actor_id", "occurred_at" DESC);
--> statement-breakpoint
CREATE INDEX "idx_audit_log_action_time" ON "audit_log" ("action", "occurred_at" DESC);
