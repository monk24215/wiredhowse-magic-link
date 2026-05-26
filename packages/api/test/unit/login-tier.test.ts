import { describe, expect, it } from 'vitest';
import { loginTierDuration } from '../../src/services/login-tier';

describe('loginTierDuration', () => {
  // ── Tier 0: first login → 2h ───────────────────────────────────────────────

  it('returns 2h for 0 prior logins (first login)', () => {
    expect(loginTierDuration(0)).toBe(2 * 3600);
  });

  // ── Tier 1: logins 2-4 → 4h ───────────────────────────────────────────────

  it('returns 4h for 1 prior login (boundary: start of tier 1)', () => {
    expect(loginTierDuration(1)).toBe(4 * 3600);
  });

  it('returns 4h for 2 prior logins', () => {
    expect(loginTierDuration(2)).toBe(4 * 3600);
  });

  it('returns 4h for 3 prior logins (boundary: end of tier 1)', () => {
    expect(loginTierDuration(3)).toBe(4 * 3600);
  });

  // ── Tier 2: logins 5-7 → 6h ───────────────────────────────────────────────

  it('returns 6h for 4 prior logins (boundary: start of tier 2)', () => {
    expect(loginTierDuration(4)).toBe(6 * 3600);
  });

  it('returns 6h for 5 prior logins', () => {
    expect(loginTierDuration(5)).toBe(6 * 3600);
  });

  it('returns 6h for 6 prior logins (boundary: end of tier 2)', () => {
    expect(loginTierDuration(6)).toBe(6 * 3600);
  });

  // ── Tier 3: logins 8+ → 12h ───────────────────────────────────────────────

  it('returns 12h for 7 prior logins (boundary: start of tier 3)', () => {
    expect(loginTierDuration(7)).toBe(12 * 3600);
  });

  it('returns 12h for 100 prior logins', () => {
    expect(loginTierDuration(100)).toBe(12 * 3600);
  });

  // ── Exact duration values ──────────────────────────────────────────────────

  it('2h is 7200 seconds', () => {
    expect(loginTierDuration(0)).toBe(7200);
  });

  it('4h is 14400 seconds', () => {
    expect(loginTierDuration(1)).toBe(14400);
  });

  it('6h is 21600 seconds', () => {
    expect(loginTierDuration(4)).toBe(21600);
  });

  it('12h is 43200 seconds', () => {
    expect(loginTierDuration(7)).toBe(43200);
  });
});
