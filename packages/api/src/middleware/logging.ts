import type { FastifyInstance } from 'fastify';
import { hashForLog } from '../lib/hashing';

export function registerRequestLogging(app: FastifyInstance): void {
  app.addHook('onRequest', (request, _reply, done) => {
    request.log.info(
      {
        method: request.method,
        url: request.url,
        ipHash: hashForLog(request.ip),
      },
      'request',
    );
    done();
  });
}
