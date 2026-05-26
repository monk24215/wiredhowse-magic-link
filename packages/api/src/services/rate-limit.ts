import { createHash } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import type Redis from 'ioredis';
import { config } from '../config';
import { getRedis } from '../lib/redis';

// Canonical sliding-window Lua script (spec/07_rate_limiting.md).
// KEYS[1] = rate limit key
// ARGV[1] = window seconds
// ARGV[2] = limit
// ARGV[3] = now (ms since epoch)
// ARGV[4] = unique entry id
// Returns [allowed (1|0), current_count, limit]
const LUA_SCRIPT = `local cutoff = ARGV[3] - (ARGV[1] * 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, cutoff)
local count = redis.call('ZCARD', KEYS[1])
if count < tonumber(ARGV[2]) then
  redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
  redis.call('EXPIRE', KEYS[1], ARGV[1] * 2)
  return {1, count + 1, ARGV[2]}
else
  return {0, count, ARGV[2]}
end`;

// Module-level SHA cache — SCRIPT LOAD is idempotent so concurrent first-calls are safe.
let cachedSha: string | null = null;

async function evalScript(
  redis: Redis,
  key: string,
  windowSec: number,
  limit: number,
): Promise<[number, number, number]> {
  const nowMs = Date.now().toString();
  const uniqueId = `${nowMs}:${Math.random().toString(36).slice(2)}`;
  const argv = [windowSec.toString(), limit.toString(), nowMs, uniqueId];

  const runEvalsha = async (sha: string) =>
    redis.evalsha(sha, 1, key, ...argv) as Promise<[number, number, number]>;

  if (!cachedSha) {
    cachedSha = (await redis.script('LOAD', LUA_SCRIPT)) as string;
  }

  try {
    return await runEvalsha(cachedSha);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('NOSCRIPT')) {
      // Script was flushed from Redis (e.g. restart); reload and retry once.
      cachedSha = (await redis.script('LOAD', LUA_SCRIPT)) as string;
      return await runEvalsha(cachedSha);
    }
    throw err;
  }
}

export interface RateLimitResult {
  allowed: boolean;
  current: number;
  limit: number;
  /** Unix seconds. Approximated as now + windowSec (avoids an extra ZRANGE round-trip). */
  resetAt: number;
}

export async function checkRateLimit(
  key: string,
  windowSec: number,
  limit: number,
  redis: Redis = getRedis(),
): Promise<RateLimitResult> {
  if (config.WH_DISABLE_RATE_LIMITS !== undefined) {
    return { allowed: true, current: 0, limit, resetAt: 0 };
  }

  const [allowed, current, lim] = await evalScript(redis, key, windowSec, limit);
  return {
    allowed: allowed === 1,
    current,
    limit: lim,
    resetAt: Math.floor(Date.now() / 1000) + windowSec,
  };
}

// ── Key helpers ───────────────────────────────────────────────────────────────

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** For IPv6, key on the /64 prefix to limit evasion via address rotation.
 *  Assumes Railway proxy sends fully-expanded IPv6 (no :: abbreviation). */
function normalizeIp(ip: string): string {
  if (!ip.includes(':')) return ip;
  return ip.split(':').slice(0, 4).join(':');
}

// ── Named helpers (one per row in spec/07 table) ──────────────────────────────

/** 15 min / 3. Silent — route always returns 200 regardless of result. */
export function checkMagicLinkPerEmail(email: string, redis?: Redis): Promise<RateLimitResult> {
  return checkRateLimit(`rl:ml-req-email:${sha256Hex(email)}`, 15 * 60, 3, redis);
}

/** 15 min / 10. 429 on breach. */
export function checkMagicLinkPerIp(ip: string, redis?: Redis): Promise<RateLimitResult> {
  return checkRateLimit(`rl:ml-req-ip:${normalizeIp(ip)}`, 15 * 60, 10, redis);
}

/** 1 hr / 50. 429 on breach. */
export function checkMagicLinkPerSite(siteId: string, redis?: Redis): Promise<RateLimitResult> {
  return checkRateLimit(`rl:ml-req-site:${siteId}`, 60 * 60, 50, redis);
}

/** 1 min / 120. 429 on breach. */
export function checkSessionCheckPerIp(ip: string, redis?: Redis): Promise<RateLimitResult> {
  return checkRateLimit(`rl:sess-check-ip:${normalizeIp(ip)}`, 60, 120, redis);
}

/** 1 hr / 10. Account lock on breach (handled by route, not limiter). */
export function checkOwnerLoginPerEmail(email: string, redis?: Redis): Promise<RateLimitResult> {
  return checkRateLimit(`rl:owner-login-email:${sha256Hex(email)}`, 60 * 60, 10, redis);
}

/** 1 min / 20. 429 on breach. */
export function checkOwnerLoginPerIp(ip: string, redis?: Redis): Promise<RateLimitResult> {
  return checkRateLimit(`rl:owner-login-ip:${normalizeIp(ip)}`, 60, 20, redis);
}

/** 1 hr / 3. Silent — route always returns 200 regardless of result. */
export function checkPasswordResetPerEmail(email: string, redis?: Redis): Promise<RateLimitResult> {
  return checkRateLimit(`rl:pwreset-email:${sha256Hex(email)}`, 60 * 60, 3, redis);
}

/** 1 min / 1. 429 on breach. */
export function checkDomainVerifyPerSite(siteId: string, redis?: Redis): Promise<RateLimitResult> {
  return checkRateLimit(`rl:domain-verify:${siteId}`, 60, 1, redis);
}

/** 1 sec / 30. 429 on breach. */
export function checkGenericPerIp(ip: string, redis?: Redis): Promise<RateLimitResult> {
  return checkRateLimit(`rl:generic-ip:${normalizeIp(ip)}`, 1, 30, redis);
}

// ── Response headers ──────────────────────────────────────────────────────────

export interface RateLimitHeaders {
  limit: number;
  remaining: number;
  reset: number;
  retryAfter?: number;
}

export function setRateLimitHeaders(reply: FastifyReply, opts: RateLimitHeaders): void {
  void reply
    .header('X-RateLimit-Limit', String(opts.limit))
    .header('X-RateLimit-Remaining', String(Math.max(0, opts.remaining)))
    .header('X-RateLimit-Reset', String(opts.reset));
  if (opts.retryAfter !== undefined) {
    void reply.header('Retry-After', String(opts.retryAfter));
  }
}
