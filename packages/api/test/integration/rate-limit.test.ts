import Redis from 'ioredis';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock config so env-var validation doesn't run at import time.
vi.mock('../../src/config', () => ({
  config: { NODE_ENV: 'test', WH_DISABLE_RATE_LIMITS: undefined },
}));

// getRedis() is never called in tests — we always pass the container Redis explicitly.
vi.mock('../../src/lib/redis', () => ({
  getRedis: () => {
    throw new Error('use explicit redis in tests');
  },
}));

// Import after mocks are registered.
const { checkRateLimit } = await import('../../src/services/rate-limit');

describe('checkRateLimit (sliding window)', () => {
  let container: StartedTestContainer;
  let redis: Redis;

  beforeAll(async () => {
    container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
    redis = new Redis({
      host: container.getHost(),
      port: container.getMappedPort(6379),
      maxRetriesPerRequest: 1,
    });
  });

  afterAll(async () => {
    await redis.quit();
    await container.stop();
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  it('allows requests up to the limit', async () => {
    for (let i = 1; i <= 3; i++) {
      const r = await checkRateLimit('rl:test:basic', 60, 3, redis);
      expect(r.allowed).toBe(true);
      expect(r.current).toBe(i);
      expect(r.limit).toBe(3);
    }
  });

  it('blocks the request that exceeds the limit', async () => {
    for (let i = 0; i < 3; i++) {
      await checkRateLimit('rl:test:block', 60, 3, redis);
    }
    const r = await checkRateLimit('rl:test:block', 60, 3, redis);
    expect(r.allowed).toBe(false);
    expect(r.current).toBe(3);
  });

  it('keeps blocking subsequent over-limit requests', async () => {
    for (let i = 0; i < 3; i++) {
      await checkRateLimit('rl:test:persist', 60, 3, redis);
    }
    for (let i = 0; i < 3; i++) {
      const r = await checkRateLimit('rl:test:persist', 60, 3, redis);
      expect(r.allowed).toBe(false);
    }
  });

  it('sliding window removes old entries after expiry', async () => {
    const key = 'rl:test:slide';

    // Fill the 1-second window.
    await checkRateLimit(key, 1, 2, redis);
    await checkRateLimit(key, 1, 2, redis);
    expect((await checkRateLimit(key, 1, 2, redis)).allowed).toBe(false);

    // Wait for window to fully drain.
    await new Promise((r) => setTimeout(r, 1200));

    const after = await checkRateLimit(key, 1, 2, redis);
    expect(after.allowed).toBe(true);
    expect(after.current).toBe(1);
  });

  it('sliding window: N+1 requests across a boundary', async () => {
    // Fire N at t=0 (all succeed, window fills); wait for full drain; fire 1 more (succeeds).
    const key = 'rl:test:boundary';
    const limit = 3;

    for (let i = 0; i < limit; i++) {
      expect((await checkRateLimit(key, 1, limit, redis)).allowed).toBe(true);
    }
    expect((await checkRateLimit(key, 1, limit, redis)).allowed).toBe(false);

    await new Promise((r) => setTimeout(r, 1200));

    const after = await checkRateLimit(key, 1, limit, redis);
    expect(after.allowed).toBe(true);
    expect(after.current).toBe(1);
  });

  it('different keys are fully independent', async () => {
    for (let i = 0; i < 2; i++) {
      await checkRateLimit('rl:test:indep-a', 60, 2, redis);
    }
    const a = await checkRateLimit('rl:test:indep-a', 60, 2, redis);
    const b = await checkRateLimit('rl:test:indep-b', 60, 2, redis);
    expect(a.allowed).toBe(false);
    expect(b.allowed).toBe(true);
  });

  it('returns correct limit value in result', async () => {
    const r = await checkRateLimit('rl:test:lim', 60, 10, redis);
    expect(r.limit).toBe(10);
  });

  it('recovers from NOSCRIPT after SCRIPT FLUSH', async () => {
    // Warm the SHA cache.
    await checkRateLimit('rl:test:noscript', 60, 5, redis);
    // Evict all scripts from Redis — simulates a server restart.
    await redis.script('FLUSH');
    // The next call must detect NOSCRIPT, reload, and succeed.
    const r = await checkRateLimit('rl:test:noscript', 60, 5, redis);
    expect(r.allowed).toBe(true);
    expect(r.current).toBe(2);
  });

  it('resetAt is a future unix timestamp', async () => {
    const before = Math.floor(Date.now() / 1000);
    const r = await checkRateLimit('rl:test:reset', 60, 5, redis);
    expect(r.resetAt).toBeGreaterThanOrEqual(before + 60);
    expect(r.resetAt).toBeLessThanOrEqual(before + 61);
  });
});
