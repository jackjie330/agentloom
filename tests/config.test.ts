import { expect, it } from 'vitest';
import {
  ConfigurationError,
  parseConfig,
  parseDatabaseConfig,
} from '../src/config/env.js';

const DATABASE_URL = 'postgresql://localhost/db';

it('rejects blank ports while preserving the default and explicit zero', () => {
  for (const PORT of ['', ' ', '\t']) {
    expect(() => parseConfig({ DATABASE_URL, PORT })).toThrow(
      ConfigurationError,
    );
  }
  expect(parseConfig({ DATABASE_URL }).PORT).toBe(3000);
  expect(parseConfig({ DATABASE_URL, PORT: '0' }).PORT).toBe(0);
  expect(parseConfig({ DATABASE_URL, PORT: '3001' }).PORT).toBe(3001);
});

it('ignores removed environment settings', () => {
  const config = parseConfig({
    DATABASE_URL,
    CORS_ORIGINS: '*',
    LOG_LEVEL: 'invalid',
    BODY_LIMIT: 'invalid',
    SHUTDOWN_TIMEOUT_MS: 'invalid',
  });
  expect(config).not.toHaveProperty('CORS_ORIGINS');
  expect(config).not.toHaveProperty('LOG_LEVEL');
  expect(config).not.toHaveProperty('BODY_LIMIT');
  expect(config).not.toHaveProperty('SHUTDOWN_TIMEOUT_MS');
});

it('validates only database settings for migrations', () => {
  expect(parseDatabaseConfig({ DATABASE_URL, PORT: 'invalid' })).toEqual({
    DATABASE_URL,
  });
  for (const value of [undefined, 'private-secret', 'https://example.com']) {
    expect(() => parseDatabaseConfig({ DATABASE_URL: value })).toThrow(
      ConfigurationError,
    );
  }
});
