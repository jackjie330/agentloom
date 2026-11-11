import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../../database/client.js';

// Depend only on the capability health checks actually use.
type HealthOptions = { database: Pick<Database, 'pool'> };

export const healthRoutes: FastifyPluginAsync<HealthOptions> = async (
  app,
  { database },
) => {
  app.get('/live', async () => ({ status: 'ok' }));
  app.get('/ready', async (request, reply) => {
    try {
      await database.pool.query('SELECT 1');
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({
        error: 'Database unavailable',
        requestId: request.id,
      });
    }
  });
};
