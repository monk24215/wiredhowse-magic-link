import { config } from '../config';

export const OWNER_SESSION_COOKIE = 'wh_owner_session';

/** 30 days in seconds */
export const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

/**
 * Build a Set-Cookie header value for the dashboard owner session.
 *
 * Secure attribute is set only in production (Railway uses HTTPS; dev uses HTTP).
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
