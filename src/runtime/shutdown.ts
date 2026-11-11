import type { FastifyInstance } from 'fastify';

export function createShutdown(
  app: FastifyInstance,
  timeoutMs: number,
  forceExit: () => void,
): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => {
    if (closing) return closing;
    // Also bounds stuck handlers and checked-out database clients.
    const timer = setTimeout(() => {
      app.server.closeAllConnections();
      forceExit();
    }, timeoutMs);
    timer.unref();
    closing = app.close().finally(() => clearTimeout(timer));
    return closing;
  };
}
