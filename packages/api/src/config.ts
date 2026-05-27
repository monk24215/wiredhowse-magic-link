import { z } from 'zod';

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid URL'),
  REDIS_URL: z.string().url('REDIS_URL must be a valid URL'),
  RESEND_API_KEY: z.string().min(1, 'RESEND_API_KEY is required'),
  RESEND_FROM: z.string().email().default('no-reply@magic-link.wiredhowse.app'),
  EMAIL_FROM_NAME: z.string().default('wiredHowse Auth'),
  EMAIL_REPLY_TO: z.string().email().default('support@wiredhowse.app'),
  SITE_URL: z.string().url().default('https://magic-link.wiredhowse.app'),
  WH_DISABLE_RATE_LIMITS: z.string().optional(),
  // Google OAuth (optional — OAuth routes return 501 if absent)
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  // Cookie domain restriction (optional — set to magic-link.wiredhowse.app in prod)
  SESSION_COOKIE_DOMAIN: z.string().optional(),
});

const parsed = configSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Missing or invalid environment variables:\n${issues}`);
}

const cfg = parsed.data;

// Safety: this flag must never be active in production.
if (cfg.WH_DISABLE_RATE_LIMITS !== undefined && cfg.NODE_ENV === 'production') {
  throw new Error('WH_DISABLE_RATE_LIMITS cannot be set when NODE_ENV=production');
}

export const config = cfg;
export type Config = typeof cfg;
