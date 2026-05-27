// ---------------------------------------------------------------------------
// Shared types for cron job functions.
// ---------------------------------------------------------------------------

/**
 * Every job returns this shape regardless of success or failure.
 * Callers log it; individual jobs catch their own errors internally.
 */
export interface JobResult {
  job: string;
  deleted: number;
  durationMs: number;
}

/**
 * Minimal structured logger interface — compatible with Fastify's pino logger
 * and any simple object that implements these three methods.
 */
export interface CronLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}
