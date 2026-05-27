import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearHandoffFragment, parseHandoffFragment } from './fragment';

describe('parseHandoffFragment', () => {
  it('returns null for an empty hash', () => {
    expect(parseHandoffFragment('')).toBeNull();
  });

  it('returns null when hash has no wh_handoff key', () => {
    expect(parseHandoffFragment('#anchor')).toBeNull();
  });

  it('returns null when wh_handoff value does not match the token pattern', () => {
    expect(parseHandoffFragment('#wh_handoff=bad')).toBeNull();
  });

  it('returns null for a token with wrong prefix', () => {
    // wh_s_ prefix is a session token, not a handoff token
    expect(parseHandoffFragment('#wh_handoff=wh_s_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBeNull();
  });

  it('returns the token for a valid wh_ho_ fragment', () => {
    const token = 'wh_ho_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    expect(parseHandoffFragment(`#wh_handoff=${token}`)).toBe(token);
  });

  it('handles a hash without the leading # character', () => {
    const token = 'wh_ho_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    expect(parseHandoffFragment(`wh_handoff=${token}`)).toBe(token);
  });

  it('handles multiple fragment keys and extracts just wh_handoff', () => {
    const token = 'wh_ho_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    expect(parseHandoffFragment(`#section=intro&wh_handoff=${token}`)).toBe(token);
  });

  it('returns null when wh_handoff is present but has an empty value', () => {
    expect(parseHandoffFragment('#wh_handoff=')).toBeNull();
  });
});

describe('clearHandoffFragment', () => {
  let originalLocation: Location;
  let originalHistory: History;

  beforeEach(() => {
    originalLocation = window.location;
    originalHistory = window.history;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not throw when history.replaceState is unavailable', () => {
    vi.stubGlobal('history', {});
    expect(() => clearHandoffFragment()).not.toThrow();
  });

  it('calls history.replaceState to remove the wh_handoff key', () => {
    const replaceState = vi.fn();
    vi.stubGlobal('history', { replaceState });

    // Set window.location properties
    vi.stubGlobal('location', {
      hash: '#wh_handoff=wh_ho_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      pathname: '/callback',
      search: '',
      href: '/callback#wh_handoff=wh_ho_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });

    clearHandoffFragment();
    expect(replaceState).toHaveBeenCalledOnce();
    // The resulting URL should not contain wh_handoff.
    const [, , newUrl] = replaceState.mock.calls[0] as [unknown, unknown, string];
    expect(newUrl).not.toContain('wh_handoff');
  });

  it('preserves other fragment keys when clearing', () => {
    const replaceState = vi.fn();
    vi.stubGlobal('history', { replaceState });
    vi.stubGlobal('location', {
      hash: '#section=intro&wh_handoff=wh_ho_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      pathname: '/page',
      search: '',
    });

    clearHandoffFragment();
    const [, , newUrl] = replaceState.mock.calls[0] as [unknown, unknown, string];
    expect(newUrl).toContain('section=intro');
    expect(newUrl).not.toContain('wh_handoff');
  });

  it('does nothing when there is no wh_handoff in the hash', () => {
    const replaceState = vi.fn();
    vi.stubGlobal('history', { replaceState });
    vi.stubGlobal('location', { hash: '#section=intro', pathname: '/page', search: '' });

    clearHandoffFragment();
    expect(replaceState).not.toHaveBeenCalled();
  });
});
