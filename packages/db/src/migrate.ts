import path from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

// Resolved relative to this file's location at runtime (tsx or compiled).
// migrations/ is always one directory above src/.
export const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

export async function runMigrations(databaseUrl: string): Promise<void> {
  const pg = postgres(databaseUrl, { max: 1 });
  const db = drizzle(pg);
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await pg.end();
  }
}

// Runnable as a script: tsx packages/db/src/migrate.ts
if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  runMigrations(url)
    .then(() => {
      console.log('Migrations complete');
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
