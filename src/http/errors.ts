import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { safeError } from '../runtime/errors.js';

export function sendError(
  status: number,
  request: FastifyRequest,
  reply: FastifyReply,
  error?: unknown,
) {
  if (status === 500) {
    request.log.error(
      {
        requestId: request.id,
        method: request.method,
        route: request.routeOptions.url,
        ...safeError(error),
      },
      'Request failed',
    );
  }
  return reply
    .header('x-request-id', request.id)
    .code(status)
    .send({
      error: status === 500 ? 'Internal server error' : 'Invalid request',
      requestId: request.id,
    });
}

export function registerErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler<{ statusCode?: number }>((error, request, reply) => {
    const status =
      error.statusCode && error.statusCode >= 400 && error.statusCode < 500
        ? error.statusCode
        : 500;
    return sendError(status, request, reply, error);
  });
  app.setNotFoundHandler((request, reply) => {
    return reply.code(404).send({ error: 'Not found', requestId: request.id });
  });
}
