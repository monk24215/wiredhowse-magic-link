import Redis from 'ioredis';
import { config } from '../config';

let _client: Redis | null = null;

export function getRedis(): Redis {
  if (!_client) {
    _client = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      lazyConnect: true,
    });
    _client.on('error', (err: unknown) => {
      // Errors surface through commands — don't exit the process here.
      // Callers handle individual command failures and return 5xx.
      void err;
    });
  }
  return _client;
}

export async function pingRedis(): Promise<boolean> {
  try {
    const result = await Promise.race([
      getRedis().ping(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 500)),
    ]);
    return result === 'PONG';
  } catch {
    return false;
  }
}
