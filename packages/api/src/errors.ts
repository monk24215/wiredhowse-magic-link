import { type ApiError, ErrorCode } from '@wiredhowse/shared';
import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';

export function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): void {
  const error: ApiError = { code, message };
  if (details !== undefined) error.details = details;
  void reply.code(statusCode).send({ error });
}

export function send400(reply: FastifyReply, message = 'Bad request'): void {
  sendError(reply, 400, ErrorCode.VALIDATION_ERROR, message);
}

export function send401(reply: FastifyReply, message = 'Unauthorized'): void {
  sendError(reply, 401, ErrorCode.UNAUTHENTICATED, message);
}

export function send403(reply: FastifyReply, message = 'Forbidden'): void {
  sendError(reply, 403, ErrorCode.FORBIDDEN, message);
}

export function send404(reply: FastifyReply, message = 'Not found'): void {
  sendError(reply, 404, ErrorCode.NOT_FOUND, message);
}

export function send429(
  reply: FastifyReply,
  message = 'Too many requests',
  details?: Record<string, unknown>,
): void {
  sendError(reply, 429, ErrorCode.RATE_LIMITED, message, details);
}

export function send500(reply: FastifyReply, message = 'Internal server error'): void {
  sendError(reply, 500, ErrorCode.INTERNAL_ERROR, message);
}

export function registerGlobalErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((_req, reply) => {
    void reply.code(404).send({
      error: { code: ErrorCode.NOT_FOUND, message: 'Route not found' },
    });
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;

    if (status === 415) {
      void reply.code(415).send({
        error: {
          code: ErrorCode.VALIDATION_ERROR,
          message: 'Content-Type must be application/json',
        },
      });
      return;
    }

    if (status === 400) {
      void reply.code(400).send({
        error: { code: ErrorCode.VALIDATION_ERROR, message: error.message },
      });
      return;
    }

    request.log.error({ err: error }, 'unhandled error');
    void reply.code(500).send({
      error: { code: ErrorCode.INTERNAL_ERROR, message: 'Internal server error' },
    });
  });
}
