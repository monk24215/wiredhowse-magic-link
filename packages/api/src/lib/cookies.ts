import { config } from '../config';

export const OWNER_SESSION_COOKIE = 'wh_owner_session';
export const CSRF_COOKIE = 'wh_csrf';

/** 30 days in seconds */
export const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

/**
 * Build a Set-Cookie header value for the dashboard owner session.
 *
 * HttpOnly so JavaScript cannot read the session token.
 * SameSite=Lax allows top-level GET navigations (login redirects, email links)
 * while blocking cross-site non-safe requests. The double-submit CSRF token
 * provides the additional layer for state-changing requests.
 * Secure is set only in production (Railway uses HTTPS; dev uses HTTP).
 * Domain is only set when SESSION_COOKIE_DOMAIN is configured in env.
 */
export function buildOwnerSessionCookie(rawToken: string): string {
  const parts: string[] = [
    `${OWNER_SESSION_COOKIE}=${encodeURIComponent(rawToken)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${SESSION_COOKIE_MAX_AGE}`,
  ];

  if (config.NODE_ENV === 'production') {
    parts.push('Secure');
  }

  if (config.SESSION_COOKIE_DOMAIN) {
    parts.push(`Domain=${config.SESSION_COOKIE_DOMAIN}`);
  }

  return parts.join('; ');
}

/**
 * Build a Set-Cookie header value for the CSRF double-submit token.
 *
 * NOT HttpOnly — the dashboard SPA reads this value via document.cookie and
 * echoes it back in the X-CSRF-Token request header on every mutation.
 * SameSite=Lax (matches the session cookie) — the double-submit check provides
 * the actual CSRF protection. The spec mandates Lax here.
 */
export function buildCsrfCookie(rawToken: string): string {
  const parts: string[] = [
    `${CSRF_COOKIE}=${encodeURIComponent(rawToken)}`,
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${SESSION_COOKIE_MAX_AGE}`,
  ];

  if (config.NODE_ENV === 'production') {
    parts.push('Secure');
  }

  if (config.SESSION_COOKIE_DOMAIN) {
    parts.push(`Domain=${config.SESSION_COOKIE_DOMAIN}`);
  }

  return parts.join('; ');
}

/**
 * Build a Set-Cookie header that clears the owner session cookie.
 */
export function clearOwnerSessionCookie(): string {
  const parts: string[] = [
    `${OWNER_SESSION_COOKIE}=`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=0',
  ];

  if (config.NODE_ENV === 'production') {
    parts.push('Secure');
  }

  if (config.SESSION_COOKIE_DOMAIN) {
    parts.push(`Domain=${config.SESSION_COOKIE_DOMAIN}`);
  }

  return parts.join('; ');
}

/**
 * Build a Set-Cookie header that clears the CSRF cookie.
 */
export function clearCsrfCookie(): string {
  const parts: string[] = [`${CSRF_COOKIE}=`, 'SameSite=Lax', 'Path=/', 'Max-Age=0'];

  if (config.NODE_ENV === 'production') {
    parts.push('Secure');
  }

  if (config.SESSION_COOKIE_DOMAIN) {
    parts.push(`Domain=${config.SESSION_COOKIE_DOMAIN}`);
  }

  return parts.join('; ');
}
