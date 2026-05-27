/**
 * Storage layer for the snippet.
 *
 * Priority order (spec § "Storage strategy"):
 *   1. localStorage["wh_session_<siteKey>"] — primary
 *   2. sessionStorage["wh_session_<siteKey>"] — fallback (private-browsing mode)
 *
 * The storage key uses the public site key (pk_...) because that is the only
 * site identifier available to the snippet. This avoids collisions when the
 * same browser holds sessions for multiple Sites.
 *
 * Raw session tokens are NEVER logged. This module only stores/retrieves them.
 */

import type { StoredSession } from './types';

function makeKey(siteKey: string): string {
  return `wh_session_${siteKey}`;
}

/**
 * Returns the first usable Storage object.
 * Tests localStorage first; falls back to sessionStorage if localStorage
 * throws (e.g. storage quota exceeded or blocked by browser policy).
 */
function getStorage(): Storage | null {
  try {
    // Probe: a read-write-delete cycle confirms the storage is actually writable.
    // This catches "storage is defined but quota is 0" in some private-browsing
    // implementations (e.g. older Safari).
    const probe = '__wh_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    // localStorage blocked — try sessionStorage
  }
  // Probe sessionStorage with the same write cycle so that if it also
  // throws, getStorage() returns null and callers never call getItem/setItem
  // on a broken storage object.
  try {
    const probe = '__wh_probe__';
    sessionStorage.setItem(probe, '1');
    sessionStorage.removeItem(probe);
    return sessionStorage;
  } catch {
    // Both blocked. Token cannot be persisted.
    return null;
  }
}

export function getStoredSession(siteKey: string): StoredSession | null {
  const storage = getStorage();
  if (!storage) return null;

  const raw = storage.getItem(makeKey(siteKey));
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('token' in parsed) ||
      !('session' in parsed) ||
      typeof (parsed as Record<string, unknown>)['token'] !== 'string'
    ) {
      return null;
    }
    return parsed as StoredSession;
  } catch {
    // Malformed JSON — discard silently.
    return null;
  }
}

export function setStoredSession(siteKey: string, data: StoredSession): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(makeKey(siteKey), JSON.stringify(data));
  } catch {
    // Storage full — silently ignore; the session will not be cached but
    // the auth flow still works (server is authoritative).
  }
}

/**
 * Clears from both localStorage and sessionStorage to handle edge cases where
 * the active storage changed between writes (e.g. private-browsing re-enabled).
 */
export function clearStoredSession(siteKey: string): void {
  const key = makeKey(siteKey);
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
  try {
    sessionStorage.removeItem(key);
  } catch {
    // ignore
  }
}
