import { z } from 'zod';

const databaseSchema = z.object({
  DATABASE_URL: z.url().refine((value) => /^postgres(ql)?:/.test(value)),
});

const environmentSchema = databaseSchema.extend({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z
    .string()
    .trim()
    .min(1)
    .pipe(z.coerce.number<string>().int().min(0).max(65535))
    .default(3000),
  LANGSMITH_TRACING: z.literal('false').default('false'),
});

export type Config = z.infer<typeof environmentSchema>;

export class ConfigurationError extends Error {}

export function parseConfig(env: NodeJS.ProcessEnv): Config {
  return parseEnvironment(environmentSchema, env);
}

export function parseDatabaseConfig(env: NodeJS.ProcessEnv) {
  return parseEnvironment(databaseSchema, env);
}

function parseEnvironment<T>(schema: z.ZodType<T>, env: NodeJS.ProcessEnv): T {
  const result = schema.safeParse(env);
  if (result.success) return result.data;

  // Never include Zod issue values: they may contain credentials.
  const fields = new Set(
    result.error.issues.map((issue) => issue.path.join('.')),
  );
  throw new ConfigurationError(
    `Invalid configuration: ${[...fields].join(', ')}`,
  );
}
