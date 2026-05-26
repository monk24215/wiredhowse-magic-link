import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // testcontainers pulls images on first run — allow up to 2 minutes.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Keep integration tests (require Docker) out of the default run.
    // Use `pnpm test:integration` to run them explicitly.
    exclude: ['**/node_modules/**', 'test/integration/**'],
  },
});
