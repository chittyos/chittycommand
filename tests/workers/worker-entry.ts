/**
 * Minimal Worker entry for the CommandCoordinator Durable Object test suite
 * (tests/workers/coordinator.test.ts), loaded via wrangler.test.jsonc.
 *
 * The production entry (src/index.ts) pulls in the Workers AI and Hyperdrive
 * bindings, neither of which has a local simulator — so
 * @cloudflare/vitest-pool-workers would open a remote proxy session against the
 * real Cloudflare account (requiring CLOUDFLARE_API_TOKEN) just to boot, which
 * is impossible offline and in CI. This entry exports only the Durable Object
 * under test, so the test config declares only that binding and the suite runs
 * fully local. See vitest.workers.config.mts.
 */
export { CommandCoordinator } from '../../meta/coordinator';

export default {
  fetch(): Response {
    return new Response('coordinator test harness — no default route', {
      status: 404,
    });
  },
};
