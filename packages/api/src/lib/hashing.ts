import { createHash } from 'node:crypto';

// Truncated sha256 hex — safe to emit in structured logs. Not reversible.
export function hashForLog(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

// Full sha256 as Buffer — for bytea storage (email hashes in archive table, etc.)
export function hashBytes(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
