import { createRequire } from 'node:module';
import { neon } from '@neondatabase/serverless';

const require = createRequire(import.meta.url);
require('esbuild-register');
const { ingestContextual } = require('../src/lib/contextual-ingest.ts');

const BRANCH_URL = process.env.DATABASE_URL;
const CTX_URL = process.env.CONTEXTUAL_DATABASE_URL;
if (!BRANCH_URL || !CTX_URL) {
  console.error('Set DATABASE_URL (branch) and CONTEXTUAL_DATABASE_URL (contextual)');
  process.exit(1);
}
const sql = neon(BRANCH_URL);

const env = {
  DATABASE_URL: BRANCH_URL,
  CONTEXTUAL_DATABASE_URL: CTX_URL,
  // router /process is 404 in prod; classifier falls through to deterministic
  // feature path (real). Set the real URL so the attempt is genuinely made.
  CHITTYROUTER_URL: 'https://router.chitty.cc',
  COMMAND_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
  // no AI binding outside the worker runtime
};

const before = (await sql`SELECT
  (SELECT count(*) FROM cc_intents WHERE intent_type='contextual_ingest') intents,
  (SELECT count(*) FROM cc_obligations WHERE source='contextual') obligations,
  (SELECT count(*) FROM cc_recommendations WHERE source='contextual') recs,
  (SELECT count(*) FROM cc_tasks WHERE source='contextual' AND task_type='reconciliation') tasks`)[0];

const result = await ingestContextual(env, sql, { limit: 50 });

const after = (await sql`SELECT
  (SELECT count(*) FROM cc_intents WHERE intent_type='contextual_ingest') intents,
  (SELECT count(*) FROM cc_obligations WHERE source='contextual') obligations,
  (SELECT count(*) FROM cc_recommendations WHERE source='contextual') recs,
  (SELECT count(*) FROM cc_tasks WHERE source='contextual' AND task_type='reconciliation') tasks`)[0];

console.log('=== ingest result ===');
console.log(JSON.stringify(result, null, 2));
console.log('=== before → after ===');
console.log('cc_intents(contextual_ingest):', before.intents, '→', after.intents);
console.log('cc_obligations(contextual):   ', before.obligations, '→', after.obligations);
console.log('cc_recommendations(contextual):', before.recs, '→', after.recs);
console.log('cc_tasks(reconciliation/contextual):', before.tasks, '→', after.tasks);
process.exit(0);
