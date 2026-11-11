import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { AIMessage } from '@langchain/core/messages';
import { createDeepAgent } from 'deepagents';
import { afterEach, expect, it, vi } from 'vitest';
import { createDatabase, type Database } from '../src/database/client.js';
import { migrateDatabase } from '../src/database/migrate.js';
import { createApp } from '../src/app.js';
import { ScriptedModel } from './helpers.js';

// Deliberately separate from DATABASE_URL: never silently target a production DB.
const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw new Error(
    'Set TEST_DATABASE_URL to a dedicated real PostgreSQL database',
  );
const databases: Database[] = [];
function database() {
  const db = createDatabase(url!);
  databases.push(db);
  return db;
}
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

it('migrates an empty database, shares one pool, and reloads SDK state across pools and repeated setup', async () => {
  const first = database();
  await migrateDatabase(first);
  expect(first.db.$client).toBe(first.pool);
  const config = { configurable: { thread_id: `step2-${randomUUID()}` } };
  const agent = createDeepAgent({
    model: new ScriptedModel([new AIMessage('saved response')]),
    checkpointer: first.saver,
  });
  await agent.invoke(
    { messages: [{ role: 'user', content: 'persist this' }] },
    config,
  );
  const end = vi.spyOn(first.pool, 'end');
  await Promise.all([first.close(), first.close()]);
  expect(end).toHaveBeenCalledTimes(1);
  const second = database();
  await migrateDatabase(second);
  await migrateDatabase(second);
  const model = new ScriptedModel([]);
  const recreated = createDeepAgent({ model, checkpointer: second.saver });
  const state = await recreated.graph.getState(config);
  expect(state.values.messages.at(-1).content).toBe('saved response');
  expect(state.next).toEqual([]);
  expect(model.seen).toHaveLength(0);
  // Saver work used this pool rather than a hidden independent connection pool.
  expect(second.pool.totalCount).toBeGreaterThan(0);
});

it('checks real readiness and reports unavailable PostgreSQL without leaking details', async () => {
  const db = database();
  const app = createApp(db);
  try {
    expect((await app.inject('/health/ready')).statusCode).toBe(200);
    await db.close();
    const response = await app.inject('/health/ready');
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: 'Database unavailable',
      requestId: response.headers['x-request-id'],
    });
    expect((await app.inject('/health/live')).statusCode).toBe(200);
  } finally {
    await app.close();
  }

  // A genuinely unreachable TCP endpoint, not a mocked pg query.
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address() as { port: number };
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const unavailableUrl = new URL(url!);
  unavailableUrl.hostname = '127.0.0.1';
  unavailableUrl.port = String(address.port);
  const unavailable = createDatabase(unavailableUrl.href);
  databases.push(unavailable);
  const offline = createApp(unavailable);
  try {
    expect((await offline.inject('/health/ready')).statusCode).toBe(503);
  } finally {
    await offline.close();
  }
});

it('runs compiled ESM with plain Node and exits on SIGTERM within a bound', async () => {
  const child = spawn(process.execPath, ['dist/server.js'], {
    env: {
      ...process.env,
      DATABASE_URL: url!,
      HOST: '127.0.0.1',
      PORT: '0',
      LANGSMITH_TRACING: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const exited = once(child, 'exit');
  try {
    const address = await new Promise<string>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        const match = output.match(
          /Server listening at (http:\/\/127\.0\.0\.1:\d+)/,
        );
        if (match) resolve(match[1]);
      });
      child.once('exit', () =>
        reject(new Error('Server exited before listening')),
      );
      child.once('error', reject);
    });
    expect((await fetch(`${address}/health/ready`)).status).toBe(200);
    const started = Date.now();
    child.kill('SIGTERM');
    const [code, signal] = await exited;
    expect(code).toBe(0);
    expect(signal).toBeNull();
    expect(Date.now() - started).toBeLessThan(3000);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}, 10000);
