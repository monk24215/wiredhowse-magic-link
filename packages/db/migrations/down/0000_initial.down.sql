-- Reverse of 0000_initial.sql — drop in reverse FK dependency order
DROP TABLE IF EXISTS "audit_log";
DROP TABLE IF EXISTS "oauth_state";
DROP TABLE IF EXISTS "password_resets";
DROP TABLE IF EXISTS "email_verifications";
DROP TABLE IF EXISTS "site_owner_sessions";
DROP TABLE IF EXISTS "archived_end_users";
DROP TABLE IF EXISTS "login_history";
DROP TABLE IF EXISTS "handoff_tokens";
DROP TABLE IF EXISTS "magic_links";
DROP TABLE IF EXISTS "sessions";
DROP TABLE IF EXISTS "end_users";
DROP TABLE IF EXISTS "sites";
DROP TABLE IF EXISTS "site_owners";
DROP TYPE IF EXISTS "public"."site_owner_auth_method";
DROP TYPE IF EXISTS "public"."site_state";
DROP EXTENSION IF EXISTS "citext";
