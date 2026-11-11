import { createApp } from './app.js';
import { ConfigurationError, parseConfig } from './config/env.js';
import { createDatabase } from './database/client.js';
import { createShutdown } from './runtime/shutdown.js';
import { logError } from './runtime/errors.js';

async function main(): Promise<void> {
  const config = parseConfig(process.env);
  process.env.LANGSMITH_TRACING = 'false';
  const database = createDatabase(config.DATABASE_URL);
  const app = createApp(database);
  const shutdown = createShutdown(app, 10000, () => {
    process.exit(1);
  });
  const stop = () => {
    void shutdown().catch((error: unknown) => {
      logError('Shutdown failed', error);
      process.exitCode = 1;
    });
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, stop);
  app.addHook('onClose', async () => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.off(signal, stop);
    }
  });

  try {
    await app.listen({ host: config.HOST, port: config.PORT });
  } catch (error) {
    await shutdown();
    throw error;
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof ConfigurationError
      ? error.message
      : 'Server startup failed';
  logError(message, error);
  process.exitCode = 1;
});
