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
    exclude: [
      // vitest's built-in defaults, restated because setting `exclude` replaces
      // them wholesale rather than appending. Dropping them here would silently
      // re-admit files the default config had always kept out.
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
      'tests/workers/**',
    ],
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
