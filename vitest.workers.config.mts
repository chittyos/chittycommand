import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * Durable Object tests run in workerd against real DO storage — not a stub.
 * Separate from vitest.config.ts, which is a node-environment suite (that
 * config excludes tests/workers/** so these files only run here).
 *
 * @cloudflare/vitest-pool-workers >= 0.20 (vitest 4) replaced the
 * `defineWorkersConfig` wrapper with the `cloudflareTest` Vite plugin.
 * The file must stay `.mts`: the package is ESM-only and the repo is CJS.
 *
 * The suite loads wrangler.test.jsonc, NOT the production wrangler.jsonc. The
 * production config declares `ai` (Workers AI) and `hyperdrive` bindings, which
 * have no local simulator, so the pool would open a remote proxy session
 * against the real Cloudflare account (requiring CLOUDFLARE_API_TOKEN) just to
 * boot — impossible offline and in CI. The test config declares only the
 * CommandCoordinator Durable Object, so everything runs locally and offline.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      singleWorker: true,
      wrangler: { configPath: './wrangler.test.jsonc' },
    }),
  ],
  test: {
    include: ['tests/workers/**/*.test.ts'],
  },
});
