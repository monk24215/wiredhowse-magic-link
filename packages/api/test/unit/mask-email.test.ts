import { describe, expect, it } from 'vitest';
import { maskEmail } from '../../src/lib/mask-email';

describe('maskEmail', () => {
  it('masks a typical email', () => {
    expect(maskEmail('alice@example.com')).toBe('a***e@example.com');
  });

  it('masks a two-character local part', () => {
    expect(maskEmail('ab@example.com')).toBe('a***b@example.com');
  });

  it('masks a single-character local part (no last char)', () => {
    expect(maskEmail('a@example.com')).toBe('a***@example.com');
  });

  it('preserves the domain exactly', () => {
    const result = maskEmail('test@sub.example.co.uk');
    expect(result).toContain('@sub.example.co.uk');
  });

  it('uses the first and last character of the local part', () => {
    expect(maskEmail('abcdefg@example.com')).toBe('a***g@example.com');
  });

  it('handles a longer email', () => {
    expect(maskEmail('hello.world+tag@mail.example.com')).toBe(
      'h***g@mail.example.com',
    );
  });

  it('returns fallback for malformed input with no @', () => {
    expect(maskEmail('notanemail')).toBe('***@***');
  });

  it('returns fallback when @ is the first character', () => {
    expect(maskEmail('@example.com')).toBe('***@***');
  });
});
