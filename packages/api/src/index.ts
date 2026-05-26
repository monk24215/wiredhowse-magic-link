import Fastify from 'fastify';
import { config } from './config';
import { healthRoutes } from './routes/health';

const server = Fastify({
  logger: {
    level: config.LOG_LEVEL,
    ...(config.NODE_ENV === 'development' && {
      transport: { target: 'pino-pretty', options: { colorize: true } },
    }),
  },
});

server.register(healthRoutes, { prefix: '/v1' });

const start = async (): Promise<void> => {
  try {
    await server.listen({ port: config.PORT, host: '0.0.0.0' });
    server.log.info({ port: config.PORT, env: config.NODE_ENV }, 'API server started');
  } catch (err) {
    server.log.error(err, 'Failed to start server');
    process.exit(1);
  }
};

start();
