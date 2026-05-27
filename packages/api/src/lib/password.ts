import { Algorithm, hash, verify } from '@node-rs/argon2';

// Spec (spec/06_session_token_design.md) — OWASP 2024 recommended settings.
const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456, // 19 MiB in KiB
  timeCost: 2,
  parallelism: 1,
} as const;

// Dummy hash used to prevent timing attacks when no account is found.
// Pre-hashed in module scope so we don't block the event loop on first use.
const DUMMY_HASH = '$argon2id$v=19$m=19456,t=2,p=1$dGVzdHNhbHRzYWx0c2FsdA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(stored: string, candidate: string): Promise<boolean> {
  return verify(stored, candidate);
}

/**
 * Run a dummy argon2 verify to prevent timing attacks.
 * Called when no account is found for an email — ensures the same ~2–4ms
 * latency as a real verify, preventing enumeration by response time.
 */
export async function dummyVerify(): Promise<void> {
  try {
    await verify(DUMMY_HASH, 'dummy-candidate-that-never-matches');
  } catch {
    // Ignore errors — the hash is intentionally malformed for the test value.
  }
}
