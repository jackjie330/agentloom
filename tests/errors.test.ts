import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { parseConfig } from '../src/config/env.js';
import { createDatabase } from '../src/database/client.js';
import { safeError } from '../src/runtime/errors.js';

const secret = 'postgresql://user:private-secret@localhost/db';
const config = parseConfig({ DATABASE_URL: secret });

it('only retains known error names and codes, never messages or custom fields', () => {
  expect(
    safeError(
      Object.assign(new TypeError(secret), {
        code: 'ECONNREFUSED',
        detail: secret,
        stack: secret,
      }),
    ),
  ).toEqual({ errorType: 'TypeError', errorCode: 'ECONNREFUSED' });
  expect(
    safeError(
      Object.assign(new Error(secret), {
        name: secret,
        code: secret,
      }),
    ),
  ).toEqual({ errorType: 'UnknownError' });
  for (const value of [
    null,
    undefined,
    secret,
    { name: secret, code: secret },
  ]) {
    expect(safeError(value)).toEqual({ errorType: 'UnknownError' });
  }
  for (const code of [
    '28P01',
    '42501',
    '42P01',
    '42703',
    '23505',
    '23503',
    '40001',
    '40P01',
  ]) {
    expect(safeError(Object.assign(new Error(secret), { code }))).toEqual({
      errorType: 'Error',
      errorCode: code,
    });
  }
});

it('logs safe request diagnostics without changing the public response', async () => {
  const database = createDatabase(config.DATABASE_URL);
  const app = createApp(database);
  const log = vi.spyOn(app.log, 'error');
  app.get('/failure/:privateValue', async () => {
    throw Object.assign(new TypeError(secret), { code: 'ECONNREFUSED' });
  });
  try {
    const response = await app.inject('/failure/private-secret');
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: 'Internal server error',
      requestId: response.headers['x-request-id'],
    });
    expect(log).toHaveBeenCalledWith(
      {
        requestId: response.headers['x-request-id'],
        method: 'GET',
        route: '/failure/:privateValue',
        errorType: 'TypeError',
        errorCode: 'ECONNREFUSED',
      },
      'Request failed',
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-secret');
  } finally {
    log.mockRestore();
    await app.close();
  }
});

it('reports idle pool errors without exposing database credentials', async () => {
  const database = createDatabase(config.DATABASE_URL);
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    database.pool.emit(
      'error',
      Object.assign(new Error(secret), {
        code: 'ECONNRESET',
        detail: secret,
      }),
    );
    expect(stderr).toHaveBeenCalledWith(
      `${JSON.stringify({
        message: 'Database idle client failed',
        errorType: 'Error',
        errorCode: 'ECONNRESET',
      })}\n`,
    );
    expect(JSON.stringify(stderr.mock.calls)).not.toContain('private-secret');
  } finally {
    stderr.mockRestore();
    await database.close();
  }
});

it.each(['server', 'migrate'])(
  'reports safe configuration fields from the %s entry point',
  (entry) => {
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', `src/${entry}.ts`],
      {
        env: { ...process.env, DATABASE_URL: 'private-secret' },
        encoding: 'utf8',
        timeout: 10000,
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(JSON.parse(child.stderr).message).toContain(
      'Invalid configuration:',
    );
    expect(JSON.parse(child.stderr).message).toContain('DATABASE_URL');
    expect(child.stderr).not.toContain('private-secret');
  },
);

it('reports migration connection errors despite unrelated invalid HTTP config', () => {
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/migrate.ts'],
    {
      env: {
        ...process.env,
        DATABASE_URL: 'postgresql://user:private-secret@127.0.0.1:1/db',
        PORT: 'invalid',
      },
      encoding: 'utf8',
      timeout: 10000,
    },
  );
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(1);
  expect(JSON.parse(child.stderr)).toEqual({
    message: 'Database migration failed',
    errorType: 'Error',
    errorCode: 'ECONNREFUSED',
  });
  expect(child.stderr).not.toContain('private-secret');
});

it('preserves the safe startup error code when the listen port is occupied', async () => {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address() as { port: number };
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: {
      ...process.env,
      DATABASE_URL: secret,
      HOST: '127.0.0.1',
      PORT: String(address.port),
      LANGSMITH_TRACING: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  try {
    const [code] = await once(child, 'exit');
    expect(code).toBe(1);
    expect(JSON.parse(stderr)).toEqual({
      message: 'Server startup failed',
      errorType: 'Error',
      errorCode: 'EADDRINUSE',
    });
    expect(stderr).not.toContain('private-secret');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
}, 10000);
