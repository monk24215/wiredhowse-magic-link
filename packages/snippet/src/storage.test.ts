import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearStoredSession, getStoredSession, setStoredSession } from './storage';
import type { StoredSession } from './types';

// ---------------------------------------------------------------------------
// Minimal Storage mock
// ---------------------------------------------------------------------------

class MockStorage implements Storage {
  private store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
  get length(): number {
    return this.store.size;
  }
}

let mockLocal: MockStorage;
let mockSession: MockStorage;

beforeEach(() => {
  mockLocal = new MockStorage();
  mockSession = new MockStorage();
  vi.stubGlobal('localStorage', mockLocal);
  vi.stubGlobal('sessionStorage', mockSession);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const SITE_KEY = 'pk_test123';
const STORED: StoredSession = {
  token: 'wh_s_abc123xyz',
  session: {
    id: 'sess_001',
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    end_user: { id: 'eu_001', email: 'test@example.com', display_name: null },
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('storage', () => {
  describe('getStoredSession', () => {
    it('returns null when nothing stored', () => {
      expect(getStoredSession(SITE_KEY)).toBeNull();
    });

    it('returns null on malformed JSON', () => {
      mockLocal.setItem(`wh_session_${SITE_KEY}`, '{bad json');
      expect(getStoredSession(SITE_KEY)).toBeNull();
    });

    it('returns null on structurally invalid JSON (no token field)', () => {
      mockLocal.setItem(`wh_session_${SITE_KEY}`, JSON.stringify({ foo: 'bar' }));
      expect(getStoredSession(SITE_KEY)).toBeNull();
    });

    it('returns null when token field is not a string', () => {
      mockLocal.setItem(`wh_session_${SITE_KEY}`, JSON.stringify({ token: 42, session: {} }));
      expect(getStoredSession(SITE_KEY)).toBeNull();
    });

    it('returns the stored session when valid', () => {
      mockLocal.setItem(`wh_session_${SITE_KEY}`, JSON.stringify(STORED));
      const result = getStoredSession(SITE_KEY);
      expect(result).not.toBeNull();
      expect(result?.token).toBe(STORED.token);
      expect(result?.session.id).toBe(STORED.session.id);
    });

    it('uses sessionStorage when localStorage throws', () => {
      vi.stubGlobal('localStorage', {
        setItem() {
          throw new Error('blocked');
        },
        getItem() {
          throw new Error('blocked');
        },
        removeItem() {
          throw new Error('blocked');
        },
      });
      mockSession.setItem(`wh_session_${SITE_KEY}`, JSON.stringify(STORED));
      const result = getStoredSession(SITE_KEY);
      expect(result?.token).toBe(STORED.token);
    });

    it('returns null when both storages throw', () => {
      const broken = {
        setItem() {
          throw new Error('blocked');
        },
        getItem() {
          throw new Error('blocked');
        },
        removeItem() {
          throw new Error('blocked');
        },
      };
      vi.stubGlobal('localStorage', broken);
      vi.stubGlobal('sessionStorage', broken);
      expect(getStoredSession(SITE_KEY)).toBeNull();
    });

    it('uses a namespaced key per site key', () => {
      mockLocal.setItem(`wh_session_pk_other`, JSON.stringify(STORED));
      expect(getStoredSession(SITE_KEY)).toBeNull();
    });
  });

  describe('setStoredSession', () => {
    it('persists to localStorage', () => {
      setStoredSession(SITE_KEY, STORED);
      const raw = mockLocal.getItem(`wh_session_${SITE_KEY}`);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!) as StoredSession;
      expect(parsed.token).toBe(STORED.token);
    });

    it('round-trips through getStoredSession', () => {
      setStoredSession(SITE_KEY, STORED);
      expect(getStoredSession(SITE_KEY)?.token).toBe(STORED.token);
    });

    it('does not throw when storage is full', () => {
      vi.stubGlobal('localStorage', {
        setItem() {
          throw new DOMException('QuotaExceededError');
        },
        getItem: () => null,
        removeItem: vi.fn(),
      });
      expect(() => setStoredSession(SITE_KEY, STORED)).not.toThrow();
    });
  });

  describe('clearStoredSession', () => {
    it('removes the key from localStorage', () => {
      mockLocal.setItem(`wh_session_${SITE_KEY}`, JSON.stringify(STORED));
      clearStoredSession(SITE_KEY);
      expect(mockLocal.getItem(`wh_session_${SITE_KEY}`)).toBeNull();
    });

    it('removes from both storages', () => {
      mockLocal.setItem(`wh_session_${SITE_KEY}`, JSON.stringify(STORED));
      mockSession.setItem(`wh_session_${SITE_KEY}`, JSON.stringify(STORED));
      clearStoredSession(SITE_KEY);
      expect(mockLocal.getItem(`wh_session_${SITE_KEY}`)).toBeNull();
      expect(mockSession.getItem(`wh_session_${SITE_KEY}`)).toBeNull();
    });

    it('does not throw when key does not exist', () => {
      expect(() => clearStoredSession(SITE_KEY)).not.toThrow();
    });

    it('does not affect keys for other site keys', () => {
      mockLocal.setItem(`wh_session_pk_other`, JSON.stringify(STORED));
      clearStoredSession(SITE_KEY);
      expect(mockLocal.getItem(`wh_session_pk_other`)).not.toBeNull();
    });
  });
});
