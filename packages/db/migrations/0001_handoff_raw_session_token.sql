-- Chunk 5c: Add raw_session_token column to handoff_tokens.
--
-- The handoff exchange endpoint (POST /v1/snippet/handoff/exchange) needs to
-- return the raw wh_s_ session token to the snippet. The raw token is generated
-- at magic-link redemption time but was previously only hashed into sessions.
-- Storing it here (for 60 s max, enforced by expires_at) closes that gap.
--
-- Safe to add NOT NULL: existing rows (if any) receive '' via the temporary
-- DEFAULT, then the DEFAULT is dropped so the NOT NULL constraint is enforced
-- by the application layer (Drizzle schema marks it .notNull()).

ALTER TABLE "handoff_tokens" ADD COLUMN "raw_session_token" text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE "handoff_tokens" ALTER COLUMN "raw_session_token" DROP DEFAULT;
