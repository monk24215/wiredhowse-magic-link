import { sql } from 'drizzle-orm';
import {
  bigserial,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { makeId } from './ids';

// ---------------------------------------------------------------------------
// Custom column types
// ---------------------------------------------------------------------------

const bytea = customType<{ data: Buffer }>({
  dataType: () => 'bytea',
});

const citext = customType<{ data: string }>({
  dataType: () => 'citext',
});

// Shorthand: timestamp with time zone
const tstz = (name: string) => timestamp(name, { withTimezone: true });

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const siteStateEnum = pgEnum('site_state', ['pending_verification', 'live', 'disabled']);

export const siteOwnerAuthMethodEnum = pgEnum('site_owner_auth_method', [
  'password',
  'google',
  'both',
]);

// ---------------------------------------------------------------------------
// site_owners
// Developer who registers an account and embeds the snippet.
// ---------------------------------------------------------------------------

export const siteOwners = pgTable(
  'site_owners',
  {
    id: text('id').primaryKey().$defaultFn(makeId.siteOwner),
    email: citext('email').notNull().unique(),
    passwordHash: text('password_hash'),
    emailVerifiedAt: tstz('email_verified_at'),
    googleSub: text('google_sub').unique(),
    authMethod: siteOwnerAuthMethodEnum('auth_method').notNull().default('password'),
    displayName: text('display_name'),
    createdAt: tstz('created_at').notNull().default(sql`now()`),
    lastLoginAt: tstz('last_login_at'),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: tstz('locked_until'),
  },
  (t) => ({
    googleSubIdx: index('idx_site_owners_google_sub')
      .on(t.googleSub)
      .where(sql`"google_sub" IS NOT NULL`),
  }),
);

// ---------------------------------------------------------------------------
// sites
// One verified domain per Site Owner (max 3 per owner enforced in app layer).
// ---------------------------------------------------------------------------

export const sites = pgTable(
  'sites',
  {
    id: text('id').primaryKey().$defaultFn(makeId.site),
    siteOwnerId: text('site_owner_id')
      .notNull()
      .references(() => siteOwners.id, { onDelete: 'cascade' }),
    domain: text('domain').notNull().unique(),
    siteKey: text('site_key').notNull().unique(),
    state: siteStateEnum('state').notNull().default('pending_verification'),
    verificationToken: text('verification_token').notNull(),
    verificationMethod: text('verification_method'),
    verifiedAt: tstz('verified_at'),
    allowedOrigins: text('allowed_origins').array().notNull().default(sql`'{}'::text[]`),
    disabledAt: tstz('disabled_at'),
    createdAt: tstz('created_at').notNull().default(sql`now()`),
  },
  (t) => ({
    siteOwnerIdx: index('idx_sites_site_owner_id').on(t.siteOwnerId),
    siteKeyIdx: index('idx_sites_site_key').on(t.siteKey),
  }),
);

// ---------------------------------------------------------------------------
// end_users
// One row per email globally — the portable wiredHowse SSO identity.
// ---------------------------------------------------------------------------

export const endUsers = pgTable('end_users', {
  id: text('id').primaryKey().$defaultFn(makeId.endUser),
  email: citext('email').notNull().unique(),
  emailVerifiedAt: tstz('email_verified_at'),
  displayName: text('display_name'),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  createdAt: tstz('created_at').notNull().default(sql`now()`),
  lastSeenAt: tstz('last_seen_at'),
});

// ---------------------------------------------------------------------------
// sessions
// Active End User session on one Site. Source of truth for token validity.
// ---------------------------------------------------------------------------

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey().$defaultFn(makeId.session),
    endUserId: text('end_user_id')
      .notNull()
      .references(() => endUsers.id, { onDelete: 'cascade' }),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    tokenHash: bytea('token_hash').notNull(),
    createdAt: tstz('created_at').notNull().default(sql`now()`),
    expiresAt: tstz('expires_at').notNull(),
    lastUsedAt: tstz('last_used_at').notNull().default(sql`now()`),
    revokedAt: tstz('revoked_at'),
    loginCountAtCreation: integer('login_count_at_creation').notNull(),
    ipHash: bytea('ip_hash').notNull(),
    userAgentHash: bytea('user_agent_hash').notNull(),
  },
  (t) => ({
    tokenHashIdx: uniqueIndex('idx_sessions_token_hash').on(t.tokenHash),
    endUserSiteIdx: index('idx_sessions_end_user_site').on(t.endUserId, t.siteId),
    expiresAtIdx: index('idx_sessions_expires_at').on(t.expiresAt).where(sql`"revoked_at" IS NULL`),
  }),
);

// ---------------------------------------------------------------------------
// magic_links
// Outstanding links awaiting redemption. 15-minute lifetime, single-use.
// ---------------------------------------------------------------------------

export const magicLinks = pgTable(
  'magic_links',
  {
    id: text('id').primaryKey().$defaultFn(makeId.magicLink),
    email: citext('email').notNull(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    tokenHash: bytea('token_hash').notNull(),
    createdAt: tstz('created_at').notNull().default(sql`now()`),
    expiresAt: tstz('expires_at').notNull(),
    redeemedAt: tstz('redeemed_at'),
    requestedIpHash: bytea('requested_ip_hash').notNull(),
    requestedUserAgentHash: bytea('requested_user_agent_hash').notNull(),
    redeemedIpHash: bytea('redeemed_ip_hash'),
  },
  (t) => ({
    tokenHashIdx: uniqueIndex('idx_magic_links_token_hash').on(t.tokenHash),
    expiresAtIdx: index('idx_magic_links_expires_at')
      .on(t.expiresAt)
      .where(sql`"redeemed_at" IS NULL`),
    emailSiteIdx: index('idx_magic_links_email_site').on(t.email, t.siteId, t.createdAt),
  }),
);

// ---------------------------------------------------------------------------
// handoff_tokens
// Bridge redemption on magic-link.wiredhowse.app → snippet on customer site.
// 60-second lifetime, single-use. Session is pre-created before issuance.
// ---------------------------------------------------------------------------

export const handoffTokens = pgTable(
  'handoff_tokens',
  {
    id: text('id').primaryKey().$defaultFn(makeId.handoffToken),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    tokenHash: bytea('token_hash').notNull(),
    // raw_session_token: stores the plaintext wh_s_ token so the snippet can
    // retrieve it via POST /v1/snippet/handoff/exchange. Lives for at most 60 s
    // (handoff TTL) then the row becomes inert (redeemed_at IS NOT NULL).
    // The cleanup cron purges these rows after 1 hour. NOT stored after that.
    rawSessionToken: text('raw_session_token').notNull(),
    createdAt: tstz('created_at').notNull().default(sql`now()`),
    expiresAt: tstz('expires_at').notNull(),
    redeemedAt: tstz('redeemed_at'),
  },
  (t) => ({
    tokenHashIdx: uniqueIndex('idx_handoff_tokens_token_hash').on(t.tokenHash),
  }),
);

// ---------------------------------------------------------------------------
// login_history
// Every successful magic-link redemption. Used to compute session-length tier.
// ON DELETE CASCADE on end_user_id: archive flow erases all history.
// ---------------------------------------------------------------------------

export const loginHistory = pgTable(
  'login_history',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    endUserId: text('end_user_id')
      .notNull()
      .references(() => endUsers.id, { onDelete: 'cascade' }),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    occurredAt: tstz('occurred_at').notNull().default(sql`now()`),
    sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    ipHash: bytea('ip_hash').notNull(),
  },
  (t) => ({
    endUserSiteIdx: index('idx_login_history_user_site').on(t.endUserId, t.siteId),
  }),
);

// ---------------------------------------------------------------------------
// archived_end_users
// Created when an End User triggers "close all sessions and archive my data."
// The end_users row is deleted (cascading to sessions and login_history).
// No PII is retained here — only hashed email and aggregated stats.
// Purged 24 months after archival.
// ---------------------------------------------------------------------------

export const archivedEndUsers = pgTable(
  'archived_end_users',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    emailHash: bytea('email_hash').notNull(),
    originalUserId: text('original_user_id').notNull(),
    archivedAt: tstz('archived_at').notNull().default(sql`now()`),
    purgeAfter: tstz('purge_after').notNull(),
    sessionSummary: jsonb('session_summary').notNull(),
  },
  (t) => ({
    purgeAfterIdx: index('idx_archived_purge').on(t.purgeAfter),
  }),
);

// ---------------------------------------------------------------------------
// site_owner_sessions
// Dashboard session for Site Owner web app. Cookie-backed (first-party).
// ---------------------------------------------------------------------------

export const siteOwnerSessions = pgTable(
  'site_owner_sessions',
  {
    id: text('id').primaryKey().$defaultFn(makeId.siteOwnerSession),
    siteOwnerId: text('site_owner_id')
      .notNull()
      .references(() => siteOwners.id, { onDelete: 'cascade' }),
    tokenHash: bytea('token_hash').notNull(),
    createdAt: tstz('created_at').notNull().default(sql`now()`),
    expiresAt: tstz('expires_at').notNull(),
    lastUsedAt: tstz('last_used_at').notNull().default(sql`now()`),
    revokedAt: tstz('revoked_at'),
    ipHash: bytea('ip_hash').notNull(),
    userAgentHash: bytea('user_agent_hash').notNull(),
  },
  (t) => ({
    tokenHashIdx: uniqueIndex('idx_site_owner_sessions_token_hash').on(t.tokenHash),
  }),
);

// ---------------------------------------------------------------------------
// email_verifications
// Site Owner email verification at signup and on email change.
// ---------------------------------------------------------------------------

export const emailVerifications = pgTable(
  'email_verifications',
  {
    id: text('id').primaryKey().$defaultFn(makeId.emailVerification),
    siteOwnerId: text('site_owner_id')
      .notNull()
      .references(() => siteOwners.id, { onDelete: 'cascade' }),
    email: citext('email').notNull(),
    tokenHash: bytea('token_hash').notNull(),
    createdAt: tstz('created_at').notNull().default(sql`now()`),
    expiresAt: tstz('expires_at').notNull(),
    verifiedAt: tstz('verified_at'),
  },
  (t) => ({
    tokenHashIdx: uniqueIndex('idx_email_verifications_token_hash').on(t.tokenHash),
  }),
);

// ---------------------------------------------------------------------------
// password_resets
// ---------------------------------------------------------------------------

export const passwordResets = pgTable(
  'password_resets',
  {
    id: text('id').primaryKey().$defaultFn(makeId.passwordReset),
    siteOwnerId: text('site_owner_id')
      .notNull()
      .references(() => siteOwners.id, { onDelete: 'cascade' }),
    tokenHash: bytea('token_hash').notNull(),
    createdAt: tstz('created_at').notNull().default(sql`now()`),
    expiresAt: tstz('expires_at').notNull(),
    usedAt: tstz('used_at'),
  },
  (t) => ({
    tokenHashIdx: uniqueIndex('idx_password_resets_token_hash').on(t.tokenHash),
  }),
);

// ---------------------------------------------------------------------------
// oauth_state
// CSRF protection for Google OAuth flows.
// ---------------------------------------------------------------------------

export const oauthState = pgTable('oauth_state', {
  id: text('id').primaryKey().$defaultFn(makeId.oauthState),
  state: text('state').notNull().unique(),
  createdAt: tstz('created_at').notNull().default(sql`now()`),
  expiresAt: tstz('expires_at').notNull(),
  consumedAt: tstz('consumed_at'),
  returnTo: text('return_to'),
});

// ---------------------------------------------------------------------------
// audit_log
// Append-only security event log. No PII — emails/IPs stored as hashes.
// ---------------------------------------------------------------------------

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    occurredAt: tstz('occurred_at').notNull().default(sql`now()`),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    ipHash: bytea('ip_hash'),
  },
  (t) => ({
    actorIdx: index('idx_audit_log_actor').on(t.actorType, t.actorId, t.occurredAt),
    actionTimeIdx: index('idx_audit_log_action_time').on(t.action, t.occurredAt),
  }),
);
