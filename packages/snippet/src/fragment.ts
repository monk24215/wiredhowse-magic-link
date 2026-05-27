/**
 * Fragment handoff parser.
 *
 * After magic-link redemption the server redirects back to the customer site
 * with `#wh_handoff=<token>` appended to the URL. Fragments are:
 *   - Never sent to servers (no log exposure in transit).
 *   - Not preserved across HTTP redirects (safe for the handoff window).
 *
 * This module reads the fragment, extracts the token, and strips it from the
 * URL using `history.replaceState` so it doesn't linger in browser history or
 * get copy-pasted accidentally.
 */

/** Matches `wh_ho_` prefix + base64url chars. */
const HANDOFF_TOKEN_RE = /^wh_ho_[A-Za-z0-9_-]{30,}$/;

/**
 * Reads `window.location.hash` for a `#wh_handoff=<token>` entry.
 * Returns the raw token string if found and format-valid, else `null`.
 *
 * Does NOT call `history.replaceState` — callers do that after a successful
 * exchange so the token is only removed once the exchange succeeds.
 */
export function parseHandoffFragment(hash: string): string | null {
  if (!hash || !hash.includes('wh_handoff=')) return null;

  // Strip the leading '#' and parse as URLSearchParams for correct decoding.
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const token = params.get('wh_handoff');
  if (!token) return null;

  if (!HANDOFF_TOKEN_RE.test(token)) return null;

  return token;
}

/**
 * Removes the `wh_handoff` key from the URL fragment using `history.replaceState`.
 * Other fragment keys (e.g. anchor links) are preserved.
 * Call this AFTER a successful handoff exchange.
 */
export function clearHandoffFragment(): void {
  try {
    if (typeof history === 'undefined' || typeof history.replaceState !== 'function') return;

    const hash = window.location.hash;
    if (!hash.includes('wh_handoff=')) return;

    const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
    params.delete('wh_handoff');

    const remaining = params.toString();
    const newUrl =
      window.location.pathname +
      window.location.search +
      (remaining ? `#${remaining}` : '');

    history.replaceState(null, '', newUrl);
  } catch {
    // history API unavailable (e.g. file:// protocol) — silently ignore.
  }
}
