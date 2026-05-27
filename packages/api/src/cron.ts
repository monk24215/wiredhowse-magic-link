/**
 * Cron service entry point.
 *
 * Compiled to dist/cron.js by the shared tsconfig.
 * Deployed as a separate Railway service alongside api.
 *
 * What this does:
 *  1. Validates env (DATABASE_URL, optional AUDIT_LOG_RETENTION_DAYS, etc.)
 *  2. Starts the node-cron scheduler (hourly + daily jobs).
 *  3. Exposes GET /healthz on HEALTHZ_PORT (default 3002) so Railway can
 *     monitor the service independently of the API.
 *
 * It does NOT import Redis, Resend, CORS, or any HTTP-facing API logic —
 * only what the jobs need (Drizzle + Postgres).
 */

import Fastify from 'fastify';
import { cronConfig } from './cron/config';
import { createScheduler } from './cron/scheduler';

const app = Fastify({
  logger: {
    level: cronConfig.LOG_LEVEL,
    ...(cronConfig.NODE_ENV === 'development' && {
      transport: { target: 'pino-pretty', options: { colorize: true } },
    }),
  },
  // The cron service doesn't handle public traffic — disable trust proxy.
  trustProxy: false,
});

let schedulerStarted = false;

// ---------------------------------------------------------------------------
// Health check — simple 200 once the scheduler is running.
// Railway monitors this endpoint independently of the API's /readyz.
// ---------------------------------------------------------------------------
app.get('/healthz', async (_req, reply) => {
  if (!schedulerStarted) {
    return reply.code(503).send({ status: 'starting' });
  }
  return reply.send({ status: 'ok' });
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
const start = async (): Promise<void> => {
  try {
    const scheduler = createScheduler(app.log);
    scheduler.start();
    schedulerStarted = true;

    // Handle graceful shutdown
    const shutdown = async (signal: string): Promise<void> => {
      app.log.info({ signal }, 'shutdown signal received');
      scheduler.stop();
      await app.close();
      process.exit(0);
    };

    process.once('SIGTERM', () => void shutdown('SIGTERM'));
    process.once('SIGINT', () => void shutdown('SIGINT'));

    await app.listen({ port: cronConfig.HEALTHZ_PORT, host: '0.0.0.0' });
    app.log.info(
      { port: cronConfig.HEALTHZ_PORT, env: cronConfig.NODE_ENV },
      'cron service started',
    );
  } catch (err) {
    app.log.error(err, 'failed to start cron service');
    process.exit(1);
  }
};

void start();
