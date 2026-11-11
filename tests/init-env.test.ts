import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { afterEach, expect, it } from 'vitest';

const script = fileURLToPath(
  new URL('../scripts/init-env.ts', import.meta.url),
);
const tsx = createRequire(import.meta.url).resolve('tsx');
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'myagents-env-'));
  directories.push(dir);
  await writeFile(
    join(dir, '.env.example'),
    await readFile(new URL('../.env.example', import.meta.url)),
  );
  return dir;
}

function run(cwd: string) {
  return spawnSync(process.execPath, ['--import', tsx, script], {
    cwd,
    encoding: 'utf8',
    timeout: 10000,
  });
}

it('generates matching random credentials once without printing secrets', async () => {
  const dir = await setup();
  const result = run(dir);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  const content = await readFile(join(dir, '.env'), 'utf8');
  const env = parseEnv(content);
  expect(env.POSTGRES_PASSWORD).toMatch(/^[a-f0-9]{64}$/);
  expect(new URL(env.DATABASE_URL!).password).toBe(env.POSTGRES_PASSWORD);
  expect(env.HOST).toBe('127.0.0.1');
  expect((await stat(join(dir, '.env'))).mode & 0o777).toBe(0o600);
  expect(result.stdout + result.stderr).not.toContain(env.POSTGRES_PASSWORD);
  expect(run(dir).status).toBe(0);
  expect(await readFile(join(dir, '.env'), 'utf8')).toBe(content);
  await expect(stat(join(dir, '.env.init'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it.each([
  'LANGSMITH_TRACING=false\n',
  'POSTGRES_PASSWORD=\nDATABASE_URL=\nPORT=3001\n',
])(
  'adds credentials to an existing env without losing other values: %s',
  async (content) => {
    const dir = await setup();
    await writeFile(join(dir, '.env'), content);
    expect(run(dir).status).toBe(0);
    const updated = parseEnv(await readFile(join(dir, '.env'), 'utf8'));
    expect(updated).toMatchObject(
      Object.fromEntries(
        Object.entries(parseEnv(content)).filter(
          ([key]) => !['POSTGRES_PASSWORD', 'DATABASE_URL'].includes(key),
        ),
      ),
    );
    expect(new URL(updated.DATABASE_URL!).password).toBe(
      updated.POSTGRES_PASSWORD,
    );
    expect(updated.POSTGRES_PASSWORD).toMatch(/^[a-f0-9]{64}$/);
  },
);

it.each([
  'DATABASE_URL=postgresql://external:secret@localhost/existing\n',
  'POSTGRES_PASSWORD=existing\nDATABASE_URL=postgresql://myagents:existing@localhost/myagents\n',
])('preserves existing database credentials: %s', async (content) => {
  const dir = await setup();
  await writeFile(join(dir, '.env'), content);
  expect(run(dir).status).toBe(0);
  expect(await readFile(join(dir, '.env'), 'utf8')).toBe(content);
});

it.each([
  'POSTGRES_PASSWORD=existing\n',
  'POSTGRES_PASSWORD=replace-with-local-password\nDATABASE_URL=postgresql://myagents:replace-with-local-password@localhost/myagents\n',
])(
  'refuses to overwrite incomplete or placeholder credentials: %s',
  async (content) => {
    const dir = await setup();
    await writeFile(join(dir, '.env'), content);
    expect(run(dir).status).toBe(1);
    expect(await readFile(join(dir, '.env'), 'utf8')).toBe(content);
  },
);

it('refuses to run while another initialization holds the lock', async () => {
  const dir = await setup();
  await writeFile(join(dir, '.env.init'), 'in progress');
  expect(run(dir).status).toBe(1);
  expect(await readFile(join(dir, '.env.init'), 'utf8')).toBe('in progress');
  await expect(stat(join(dir, '.env'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
