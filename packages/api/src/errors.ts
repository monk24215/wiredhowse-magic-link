import { type ApiError, ErrorCode } from '@wiredhowse/shared';
import type { FastifyReply } from 'fastify';

export function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: ErrorCode,
  message: string,
): void {
  const body: ApiError = { code, message };
  reply.code(statusCode).send(body);
}

export function send400(reply: FastifyReply, message = 'Bad request'): void {
  sendError(reply, 400, ErrorCode.VALIDATION_ERROR, message);
}

export function send401(reply: FastifyReply, message = 'Unauthorized'): void {
  sendError(reply, 401, ErrorCode.UNAUTHORIZED, message);
}

export function send403(reply: FastifyReply, message = 'Forbidden'): void {
  sendError(reply, 403, ErrorCode.FORBIDDEN, message);
}

export function send404(reply: FastifyReply, message = 'Not found'): void {
  sendError(reply, 404, ErrorCode.SITE_NOT_FOUND, message);
}

export function send429(reply: FastifyReply, message = 'Too many requests'): void {
  sendError(reply, 429, ErrorCode.RATE_LIMITED, message);
}

export function send500(reply: FastifyReply, message = 'Internal server error'): void {
  sendError(reply, 500, ErrorCode.INTERNAL_ERROR, message);
}
