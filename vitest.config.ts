import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.spec.ts'],
    // tests/workers/** runs in workerd via vitest.workers.config.mts (npm run
    // test:workers). Those files import the `cloudflare:test` virtual module,
    // which only exists under that pool, so the node suite must not collect them.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/workers/**'],
    testTimeout: 15000,
    pool: 'threads',
    maxWorkers: 1,
    globalSetup: ['./tests/setup/global-setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
