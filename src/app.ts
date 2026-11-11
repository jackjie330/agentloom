import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { Database } from './database/client.js';
import { registerErrorHandlers, sendError } from './http/errors.js';
import { registerRequestHooks } from './http/requests.js';
import { healthRoutes } from './modules/health/routes.js';

export function createApp(database: Database) {
  const app = Fastify({
    logger: {
      level: 'info',
      serializers: {
        req: (request) => ({ method: request.method }),
        res: (reply) => ({ statusCode: reply.statusCode }),
      },
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    forceCloseConnections: 'idle',
    // Routing errors bypass both onRequest and the normal error handler.
    frameworkErrors: (error, request, reply) =>
      sendError(error.statusCode ?? 500, request, reply, error),
  });

  registerErrorHandlers(app);
  registerRequestHooks(app);
  app.register(healthRoutes, { prefix: '/health', database });
  app.addHook('onClose', async () => {
    await database.close();
  });
  return app;
}
