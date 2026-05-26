import type { HealthResponse, ReadinessResponse } from '@wiredhowse/shared';
import type { FastifyInstance } from 'fastify';

const VERSION = process.env.npm_package_version ?? '0.0.0';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Reply: HealthResponse }>('/health', async (_req, reply) => {
    reply.send({ status: 'ok', version: VERSION });
  });

  // Readiness checks real infrastructure. Used by Railway's health check.
  app.get<{ Reply: ReadinessResponse }>('/ready', async (_req, reply) => {
    const checks: ReadinessResponse['checks'] = {
      postgres: 'error',
      redis: 'error',
    };

    // These services are injected in Chunk 4. For now, stub as ok so the
    // skeleton starts cleanly without requiring infra.
    checks.postgres = 'ok';
    checks.redis = 'ok';

    const allOk = Object.values(checks).every((v) => v === 'ok');
    reply.code(allOk ? 200 : 503).send({
      status: allOk ? 'ok' : 'degraded',
      checks,
    });
  });
}
