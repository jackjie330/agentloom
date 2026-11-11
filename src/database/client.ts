import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { logError } from '../runtime/errors.js';

export function createDatabase(connectionString: string) {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 10000,
    statement_timeout: 2000,
    query_timeout: 3000,
  });
  // pg emits idle client errors outside query promises. Do not expose credentials.
  pool.on('error', (error) => logError('Database idle client failed', error));

  let closing: Promise<void> | undefined;
  return {
    pool,
    db: drizzle(pool),
    saver: new PostgresSaver(pool),
    close: () => (closing ??= pool.end()),
  };
}

export type Database = ReturnType<typeof createDatabase>;
