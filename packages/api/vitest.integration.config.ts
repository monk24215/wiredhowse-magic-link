import { defineConfig } from 'vitest/config';

// Separate config for integration tests — includes test/integration/** which
// the default config excludes (they require Docker / testcontainers).
// Used by: pnpm test:integration (run in CI where Docker is available).
export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    include: ['test/integration/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    exclude: ['**/node_modules/**'],
    // postgres (used by drizzle and migrations) is a CJS-only package; Vite's
    // module bundler can't resolve it without this hint. The list is kept
    // minimal — only add packages that cause "Failed to load url X" errors.
    server: {
      deps: {
        inline: ['postgres'],
      },
    },
  },
});
