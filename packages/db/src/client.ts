import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

// Fail-closed: if Postgres is unreachable, queries throw and callers return 5xx.
// No degraded mode. Connection pool size tuned conservatively for Railway free tier.
const pgClient = postgres(url, { max: 10 });

export const db = drizzle(pgClient, { schema });

export type Database = typeof db;
