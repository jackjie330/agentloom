import type { Database } from './client.js';

export async function migrateDatabase(database: Database): Promise<void> {
  // Business migrations belong here when the first business table is introduced.
  // Checkpoint schema is owned exclusively by the official saver.
  await database.saver.setup();
}
