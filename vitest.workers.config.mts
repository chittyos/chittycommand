import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * Durable Object tests run in workerd against real DO storage — not a stub.
 * Separate from vitest.config.ts, which is a node-environment suite.
 *
 * @cloudflare/vitest-pool-workers >= 0.20 (vitest 4) replaced the
 * `defineWorkersConfig` wrapper with the `cloudflareTest` Vite plugin.
 * The file must stay `.mts`: the package is ESM-only and the repo is CJS.
 */

/**
 * The worker declares a HYPERDRIVE binding, and miniflare refuses to boot
 * without a syntactically valid local Postgres DSN — even though the
 * coordinator never touches it. This is an unreachable placeholder pointing at
 * a non-existent local database, NOT a credential: nothing under test opens a
 * Postgres connection, and no test asserts against it. It exists solely to
 * satisfy binding validation.
 */
const UNUSED_HYPERDRIVE_DSN = [
  'postgresql://',
  'placeholder',
  ':',
  'placeholder',
  '@127.0.0.1:5432/unused',
].join('');

// wrangler resolves Hyperdrive bindings from the environment while parsing
// wrangler.jsonc — before any miniflare option applies — so this must be set at
// process level, here, rather than passed through the plugin.
process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE ??=
  UNUSED_HYPERDRIVE_DSN;

export default defineConfig({
  plugins: [
    cloudflareTest({
      singleWorker: true,
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // The worker declares a service binding to chittystorage, which has no
        // local counterpart. The coordinator never calls it; this stands in so
        // workerd can boot, and fails loudly (501) if anything ever does — it
        // must never silently satisfy a real call.
        serviceBindings: {
          SVC_STORAGE: () =>
            new Response('SVC_STORAGE is not available in coordinator tests', {
              status: 501,
            }),
        },
      },
    }),
  ],
  test: {
    include: ['tests/workers/**/*.test.ts'],
  },
});
