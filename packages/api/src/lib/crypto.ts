import { createHash, timingSafeEqual as nodeTimingSafeEqual, randomBytes } from 'node:crypto';

export function generateToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

// Returns a Buffer for storage as `bytea` in Postgres.
export function hashToken(raw: string): Buffer {
  return createHash('sha256').update(raw).digest();
}

export function timingSafeCompare(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return nodeTimingSafeEqual(a, b);
}
