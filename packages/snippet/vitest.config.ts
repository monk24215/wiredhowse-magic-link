import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Use happy-dom so that window, document, localStorage, sessionStorage,
    // history, and location are all defined — this is browser code.
    environment: 'happy-dom',
  },
});
