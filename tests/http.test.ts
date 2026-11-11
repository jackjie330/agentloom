import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createShutdown } from '../src/runtime/shutdown.js';
import { parseConfig } from '../src/config/env.js';
import { createDatabase } from '../src/database/client.js';

const config = parseConfig({
  DATABASE_URL: 'postgresql://unused:secret@127.0.0.1/db',
});
const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup() {
  const database = createDatabase(config.DATABASE_URL);
  const app = createApp(database);
  apps.push(app);
  return { app, database };
}

describe('HTTP foundation', () => {
  it('rejects invalid config without leaking supplied secrets', () => {
    for (const env of [
      { DATABASE_URL: 'secret' },
      { DATABASE_URL: config.DATABASE_URL, PORT: '-1' },
      { DATABASE_URL: config.DATABASE_URL, LANGSMITH_TRACING: 'true' },
    ]) {
      expect(() => parseConfig(env)).toThrow('Invalid configuration:');
      try {
        parseConfig(env);
      } catch (error) {
        expect(String(error)).not.toContain('secret');
      }
    }
  });

  it('serves liveness and server-owned IDs without handling CORS', async () => {
    const { app } = setup();
    const allowed = await app.inject({
      url: '/health/live',
      headers: {
        origin: 'https://allowed.example',
        'x-request-id': 'untrusted',
      },
    });
    expect(allowed.json()).toEqual({ status: 'ok' });
    expect(allowed.headers['x-request-id']).not.toBe('untrusted');
    expect(allowed.headers['access-control-allow-origin']).toBeUndefined();
    const denied = await app.inject({
      url: '/health/live',
      headers: { origin: 'https://denied.example' },
    });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('normalizes routing errors without exposing raw URLs', async () => {
    const { app } = setup();
    const response = await app.inject({
      url: '/private-secret%ZZ',
      headers: { 'x-request-id': 'untrusted' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
    expect(response.headers['x-request-id']).not.toBe('untrusted');
    expect(response.json()).toEqual({
      error: 'Invalid request',
      requestId: response.headers['x-request-id'],
    });
    expect(response.body).not.toContain('private-secret');
  });

  it('leaves preflight handling to Nginx', async () => {
    const { app } = setup();
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/health/live',
      headers: {
        origin: 'https://allowed.example',
        'access-control-request-method': 'GET',
        'x-request-id': 'untrusted',
      },
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
    expect(response.headers['x-request-id']).not.toBe('untrusted');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();

    for (const headers of [
      { origin: 'https://allowed.example' },
      { 'access-control-request-method': 'GET' },
      {},
    ]) {
      const invalid = await app.inject({
        method: 'OPTIONS',
        url: '/health/live',
        headers,
      });
      expect(invalid.statusCode).toBe(404);
      expect(invalid.headers['content-type']).toContain('application/json');
      expect(invalid.headers['x-request-id']).toEqual(expect.any(String));
      expect(invalid.json()).toEqual({
        error: 'Not found',
        requestId: invalid.headers['x-request-id'],
      });
    }
  });

  it('normalizes 404, malformed JSON, oversized bodies and unexpected errors', async () => {
    const { app } = setup();
    app.post('/test', async () => {
      throw new Error('secret');
    });
    for (const [payload, status] of [
      ['{', 400],
      ['x'.repeat(1048577), 413],
      ['{}', 500],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: '/test',
        headers: { 'content-type': 'application/json' },
        payload,
      });
      expect(response.statusCode).toBe(status);
      expect(response.json().requestId).toBe(response.headers['x-request-id']);
      expect(response.body).not.toContain('secret');
    }
    expect((await app.inject('/missing')).statusCode).toBe(404);
  });

  it('drains requests and closes the shared pool only once', async () => {
    const { app, database } = setup();
    const end = vi.spyOn(database.pool, 'end');
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    app.get('/blocked', async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return 'done';
    });
    const request = app.inject('/blocked');
    await started;
    const force = vi.fn();
    const shutdown = createShutdown(app, 1000, force);
    const closing = shutdown();
    expect(shutdown()).toBe(closing);
    expect(end).not.toHaveBeenCalled();
    release();
    await request;
    await closing;
    await database.close();
    expect(end).toHaveBeenCalledTimes(1);
    expect(force).not.toHaveBeenCalled();
  });

  it('invokes the hard deadline for a stuck request', async () => {
    const { app } = setup();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    app.get('/stuck', async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return 'done';
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const request = fetch(`${address}/stuck`).catch(() => undefined);
    await started;
    let forced!: () => void;
    const deadline = new Promise<void>((resolve) => {
      forced = resolve;
    });
    const closing = createShutdown(app, 100, forced)();
    await deadline;
    release();
    await request;
    await closing;
  });
});
