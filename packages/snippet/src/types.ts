// Public types that match the spec exactly.
// Field names are snake_case to mirror the JSON wire format.

export interface Session {
  id: string;
  expires_at: string;
  end_user: {
    id: string;
    email: string;
    display_name: string | null;
  };
}

export interface AuthError {
  code: string;
  message: string;
}

export type AuthEvent = 'session' | 'signout' | 'site_disabled' | 'error' | 'ready';

export interface RequireSessionOptions {
  /** Optional intro text shown inside the email-entry iframe. */
  message?: string;
  /** Override where the magic link returns to. Default: current URL. */
  redirectTo?: string;
}

/** Serialised form stored in localStorage / sessionStorage. */
export interface StoredSession {
  /** Raw wh_s_ session token (never logged, only sent as Bearer). */
  token: string;
  session: Session;
}
