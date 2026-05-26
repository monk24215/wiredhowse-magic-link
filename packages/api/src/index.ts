import fastifyHelmet from '@fastify/helmet';
import Fastify from 'fastify';
import { config } from './config';
import { registerGlobalErrorHandler } from './errors';
import { registerRequestLogging } from './middleware/logging';
import { healthRoutes } from './routes/health';

const server = Fastify({
  logger: {
    level: config.LOG_LEVEL,
    ...(config.NODE_ENV === 'development' && {
      transport: { target: 'pino-pretty', options: { colorize: true } },
    }),
  },
  // Trust Railway's load balancer for real client IP in request.ip
  trustProxy: true,
});

// Security headers. CSP disabled — this is a JSON API, not an HTML host.
void server.register(fastifyHelmet, { contentSecurityPolicy: false });

registerGlobalErrorHandler(server);
registerRequestLogging(server);

// Health / readiness at top-level paths (no /v1 prefix — Railway uses /readyz)
void server.register(healthRoutes);

const start = async (): Promise<void> => {
  try {
    await server.listen({ port: config.PORT, host: '0.0.0.0' });
    server.log.info({ port: config.PORT, env: config.NODE_ENV }, 'API server started');
  } catch (err) {
    server.log.error(err, 'Failed to start server');
    process.exit(1);
  }
};

void start();
