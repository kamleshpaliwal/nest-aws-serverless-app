/**
 * Runs once at startup. If config is wrong we crash IMMEDIATELY with a clear
 * message ("fail fast") instead of failing later on the first request.
 * BUCKET_NAME gets added here in Phase 5.
 */
export function validateEnv(env: Record<string, unknown>) {
  const port = env.PORT === undefined ? 3000 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, got "${String(env.PORT)}"`);
  }

  if (typeof env.TABLE_NAME !== 'string' || env.TABLE_NAME.length === 0) {
    throw new Error('TABLE_NAME is required (the DynamoDB table name)');
  }

  // DYNAMODB_ENDPOINT is optional: set it only for DynamoDB Local.
  return { ...env, PORT: port };
}
