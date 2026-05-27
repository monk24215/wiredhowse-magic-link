import { z } from 'zod';

// Cron service config — a subset of the api config (no Redis, Resend, CORS, etc.)
// plus an extra AUDIT_LOG_RETENTION_DAYS knob.
const cronConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid URL'),
  HEALTHZ_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  // Retention for audit_log rows. Default: 90 days. Set lower in dev if desired.
  AUDIT_LOG_RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
});

const parsed = cronConfigSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`[cron] Missing or invalid environment variables:\n${issues}`);
}

export const cronConfig = parsed.data;
export type CronConfig = typeof cronConfig;
