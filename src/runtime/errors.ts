import { constants } from 'node:os';

const errorNames = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'URIError',
  'EvalError',
  'AggregateError',
  'AbortError',
]);
const errorCodes = new Set([
  ...Object.keys(constants.errno),
  '28P01', // PostgreSQL authentication failure.
  '3D000', // Missing database.
  '42501', // Insufficient privilege.
  '42P01', // Undefined table.
  '42703', // Undefined column.
  '23505', // Unique constraint violation.
  '23503', // Foreign key constraint violation.
  '40001', // Serialization failure.
  '40P01', // Deadlock detected.
  '53300', // Too many connections.
  '57P01', // Database shutdown.
  '57014', // Query cancelled or timed out.
]);

export function safeError(error: unknown) {
  const name = error instanceof Error ? error.name : undefined;
  const code =
    error instanceof Error && 'code' in error ? error.code : undefined;
  // Names and codes can contain user input too; never log unrecognised values.
  return {
    errorType: name && errorNames.has(name) ? name : 'UnknownError',
    ...(typeof code === 'string' && errorCodes.has(code)
      ? { errorCode: code }
      : {}),
  };
}

export function logError(message: string, error: unknown): void {
  process.stderr.write(`${JSON.stringify({ message, ...safeError(error) })}\n`);
}
