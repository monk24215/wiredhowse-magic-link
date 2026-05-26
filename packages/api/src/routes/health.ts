import { db } from '@wiredhowse/db';
import type { HealthResponse, ReadinessResponse } from '@wiredhowse/shared';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { pingRedis } from '../lib/redis';

const VERSION = process.env.npm_package_version ?? '0.0.0';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Reply: HealthResponse }>('/healthz', async (_req, reply) => {
    void reply.send({ status: 'ok', version: VERSION });
  });

  // Readiness checks DB + Redis within a 500ms deadline each.
  // Railway uses this for rolling deploys — returns 503 until both are reachable.
  app.get('/readyz', async (_req, reply) => {
    const checks: ReadinessResponse['checks'] = {
      postgres: 'error',
      redis: 'error',
    };

    await Promise.allSettled([
      Promise.race([
        db.execute(sql`SELECT 1`).then(() => {
          checks.postgres = 'ok';
        }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 500)),
      ]),
      pingRedis().then((ok) => {
        if (ok) checks.redis = 'ok';
      }),
    ]);

    const allOk = checks.postgres === 'ok' && checks.redis === 'ok';
    const body: ReadinessResponse = { status: allOk ? 'ok' : 'error', checks };
    void reply.code(allOk ? 200 : 503).send(body);
  });
}
