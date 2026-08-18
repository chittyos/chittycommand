import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.spec.ts'],
    // tests/workers/** runs in workerd via vitest.workers.config.mts and imports
    // `cloudflare:test`, which only resolves under @cloudflare/vitest-pool-workers.
    // Without this exclude the node suite globs those files and dies at import.
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
