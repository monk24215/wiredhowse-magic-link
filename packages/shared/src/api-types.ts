// Request / response shapes for every API endpoint.
// Field names mirror the JSON wire format (snake_case per spec).
// Validated at the network boundary with the Zod schemas in zod-schemas.ts.

// ---------------------------------------------------------------------------
// API envelope
// ---------------------------------------------------------------------------

export type ApiSuccess<T> = { data: T };

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiErrorBody;

// ---------------------------------------------------------------------------
// Shared sub-types
// ---------------------------------------------------------------------------

export interface EndUserPublic {
  id: string;
  email: string;
  display_name: string | null;
}

export interface SessionData {
  id: string;
  expires_at: string;
  end_user: EndUserPublic;
}

// ---------------------------------------------------------------------------
// /v1/snippet/session/check
// ---------------------------------------------------------------------------

export interface SessionCheckBody {
  token?: string;
}

export type SessionCheckResponse =
  | { valid: true; session: SessionData }
  | { valid: false };

// ---------------------------------------------------------------------------
// /v1/snippet/magic-link/request
// ---------------------------------------------------------------------------

export interface MagicLinkRequestBody {
  email: string;
}

export interface MagicLinkRequestResponse {
  sent: boolean;
  expires_in_seconds: number;
}

// ---------------------------------------------------------------------------
// /v1/snippet/handoff/exchange
// ---------------------------------------------------------------------------

export interface HandoffExchangeBody {
  handoff_token: string;
}

export interface HandoffExchangeResponse {
  session_token: string;
  session: SessionData;
}

// ---------------------------------------------------------------------------
// /v1/snippet/sign-out
// ---------------------------------------------------------------------------

export interface SignOutResponse {
  signed_out: boolean;
}

// ---------------------------------------------------------------------------
// /v1/magic/preflight
// ---------------------------------------------------------------------------

export interface MagicPreflightResponse {
  /** Partially masked — e.g. "a***e@example.com" */
  email: string;
  site_domain: string;
  expires_at: string;
}

// ---------------------------------------------------------------------------
// /v1/me
// ---------------------------------------------------------------------------

export interface EndUserProfile {
  id: string;
  email: string;
  display_name: string | null;
  created_at: string;
  last_seen_at: string | null;
}

export interface UpdateMeBody {
  display_name?: string;
}

// ---------------------------------------------------------------------------
// /v1/me/sessions
// ---------------------------------------------------------------------------

export interface SessionWithSite {
  id: string;
  site: { id: string; domain: string };
  created_at: string;
  expires_at: string;
  last_used_at: string;
  is_current: boolean;
}

export interface MeSessionsResponse {
  sessions: SessionWithSite[];
}

// ---------------------------------------------------------------------------
// /v1/me/close-and-archive
// ---------------------------------------------------------------------------

export interface CloseAndArchiveBody {
  /** Must equal exactly "DELETE MY DATA" */
  confirmation: string;
}

// ---------------------------------------------------------------------------
// /v1/me/export
// ---------------------------------------------------------------------------

export interface LoginHistoryEntry {
  id: number;
  site: { id: string; domain: string };
  occurred_at: string;
}

export interface MeExportResponse {
  profile: EndUserProfile;
  sessions: SessionWithSite[];
  login_history: LoginHistoryEntry[];
  exported_at: string;
}

// ---------------------------------------------------------------------------
// /v1/auth/*  — Site Owner authentication
// ---------------------------------------------------------------------------

export interface SignupBody {
  email: string;
  password: string;
}

export interface LoginBody {
  email: string;
  password: string;
}

export interface VerifyEmailBody {
  token: string;
}

export interface RequestPasswordResetBody {
  email: string;
}

export interface ResetPasswordBody {
  token: string;
  new_password: string;
}

// ---------------------------------------------------------------------------
// /v1/dashboard/*  — Site Owner dashboard API
// ---------------------------------------------------------------------------

export type SiteState = 'pending_verification' | 'live' | 'disabled';

export interface SiteDetail {
  id: string;
  domain: string;
  site_key: string;
  state: SiteState;
  verification_token: string;
  verification_method: string | null;
  verified_at: string | null;
  allowed_origins: string[];
  created_at: string;
  disabled_at: string | null;
}

export interface DashboardSitesResponse {
  sites: SiteDetail[];
}

export interface CreateSiteBody {
  domain: string;
}

export interface UpdateSiteBody {
  allowed_origins?: string[];
  /** Only 'live' and 'disabled' are toggleable; 'pending_verification' is set by the server */
  state?: 'live' | 'disabled';
}

export interface VerifySiteResponse {
  verified: boolean;
  method?: 'dns' | 'meta';
  checked_at?: string;
  next_check_allowed_at?: string;
}

export interface ClearSessionsResponse {
  revoked_count: number;
}

export interface SiteMetrics {
  active_sessions: number;
  logins_24h: number;
  logins_7d: number;
  logins_30d: number;
  last_activity_at: string | null;
}

export interface SiteOwnerProfile {
  id: string;
  email: string;
  display_name: string | null;
  auth_method: 'password' | 'google' | 'both';
  email_verified_at: string | null;
  created_at: string;
  last_login_at: string | null;
}

export interface UpdateAccountBody {
  display_name?: string;
  current_password?: string;
  new_password?: string;
}

// ---------------------------------------------------------------------------
// /v1/identity/*  — internal SSO contract for other wiredHowse apps
// ---------------------------------------------------------------------------

export interface WiredHowseIdentity {
  id: string;
  email: string;
  email_verified_at: string | null;
  display_name: string | null;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// /healthz  /readyz
// ---------------------------------------------------------------------------

export interface HealthResponse {
  status: 'ok';
}

export interface ReadinessResponse {
  status: 'ok' | 'error';
  checks: {
    postgres: 'ok' | 'error';
    redis: 'ok' | 'error';
  };
}
