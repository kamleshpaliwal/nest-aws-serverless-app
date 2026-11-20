/**
 * Runs once at startup. If config is wrong we crash IMMEDIATELY with a clear
 * message ("fail fast") instead of failing later on the first request.
 * TABLE_NAME and BUCKET_NAME get added here in Phases 3 and 5.
 */
export function validateEnv(env: Record<string, unknown>) {
  const port = env.PORT === undefined ? 3000 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, got "${String(env.PORT)}"`);
  }
  return { ...env, PORT: port };
}
