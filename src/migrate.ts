import { ConfigurationError, parseDatabaseConfig } from './config/env.js';
import { createDatabase } from './database/client.js';
import { migrateDatabase } from './database/migrate.js';
import { logError } from './runtime/errors.js';

async function main(): Promise<void> {
  const config = parseDatabaseConfig(process.env);
  const database = createDatabase(config.DATABASE_URL);
  try {
    await migrateDatabase(database);
    process.stdout.write('Database ready\n');
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  logError(
    error instanceof ConfigurationError
      ? error.message
      : 'Database migration failed',
    error,
  );
  process.exitCode = 1;
});
