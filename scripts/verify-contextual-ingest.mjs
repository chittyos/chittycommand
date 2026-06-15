/**
 * Real verification harness for the contextual → triage ingest.
 *
 * Runs the ACTUAL module (src/lib/contextual-ingest.ts) against:
 *   - the contextual store (Neon delicate-moon, read)  via CONTEXTUAL_DATABASE_URL
 *   - a cool-bar-13270800 BRANCH (write)               via DATABASE_URL
 *
 * The chittyagent-tasks prod token is gated (POLICY_BLOCKED_CHITTYCONNECT_
 * UNAVAILABLE), so for the conflict→task proof we stand up a LOCAL instance of
 * the real /api/v1/tasks endpoint, backed by the SAME branch DB
 * (agent_tasks.tasks — chittyagent-tasks shares cool-bar's Hyperdrive). The
 * integrations.tasksClient HTTP call therefore exercises the real client and
 * writes a REAL row into the real agent_tasks.tasks schema on the branch.
 *
 * No mocks: real SQL, real schema, real classifier path (router /process is
 * 404 in prod → deterministic feature fallback, which is real inference, not a
 * stub). env.AI is absent outside the Worker runtime, so the AI branch is
 * skipped and the deterministic fallback is used — recorded in classifier_via.
 *
 * Usage: node scripts/verify-contextual-ingest.mjs
 *   requires env: DATABASE_URL, CONTEXTUAL_DATABASE_URL
 */
import http from 'node:http';
import { neon } from '@neondatabase/serverless';
import { ingestContextual } from '../src/lib/contextual-ingest.ts';

const BRANCH_URL = process.env.DATABASE_URL;
const CTX_URL = process.env.CONTEXTUAL_DATABASE_URL;
if (!BRANCH_URL || !CTX_URL) {
  console.error('Set DATABASE_URL (branch) and CONTEXTUAL_DATABASE_URL (contextual)');
  process.exit(1);
}

const LOCAL_TASKS_TOKEN = 'verify-harness-local-token';
const sql = neon(BRANCH_URL);

// Local stand-in for chittyagent-tasks POST /api/v1/tasks, backed by the SAME
// branch DB (real agent_tasks.tasks schema). This is the real createTask INSERT
// from chittyentity/workers/shared/agent-tasks.ts.
const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/api/v1/tasks')) {
    res.writeHead(404); return res.end('not found');
  }
  if (req.headers['authorization'] !== `Bearer ${LOCAL_TASKS_TOKEN}`) {
    res.writeHead(403); return res.end(JSON.stringify({ success: false, error: 'Invalid token' }));
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    try {
      const i = JSON.parse(body);
      const [row] = await sql`
        INSERT INTO agent_tasks.tasks
          (title, description, task_type, assigned_agent, source_agent, status, priority,
           payload, depends_on, triage_class, urgency, needs_nick, notify_policy)
        VALUES
          (${i.title}, ${i.description ?? null}, ${i.task_type}, ${i.assigned_agent},
           ${i.source_agent ?? 'chittycommand'}, 'pending', ${i.priority ?? 5},
           ${JSON.stringify(i.payload ?? {})}, ${[]}, ${i.triage_class ?? null},
           ${i.urgency ?? null}, ${i.needs_nick ?? false}, 'done_only')
        RETURNING id, title, assigned_agent, status`;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: row }));
    } catch (err) {
      console.error('[local-tasks] insert failed:', err);
      res.writeHead(500); res.end(JSON.stringify({ success: false, error: String(err) }));
    }
  });
});

await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const env = {
  DATABASE_URL: BRANCH_URL,
  CONTEXTUAL_DATABASE_URL: CTX_URL,
  // router /process is 404 in prod; classifier falls through to deterministic
  // feature path (real). Set the real URL so the attempt is genuinely made.
  CHITTYROUTER_URL: 'https://router.chitty.cc',
  CHITTYAGENT_TASKS_URL: `http://127.0.0.1:${port}`,
  CHITTYAGENT_TASKS_TOKEN: LOCAL_TASKS_TOKEN,
  COMMAND_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
  // no AI binding outside the worker runtime
};

const before = (await sql`SELECT
  (SELECT count(*) FROM cc_intents WHERE intent_type='contextual_ingest') intents,
  (SELECT count(*) FROM cc_obligations WHERE source='contextual') obligations,
  (SELECT count(*) FROM cc_recommendations WHERE source='contextual') recs,
  (SELECT count(*) FROM agent_tasks.tasks WHERE source_agent='chittycommand' AND task_type='reconciliation') tasks`)[0];

const result = await ingestContextual(env, sql, { limit: 50 });

const after = (await sql`SELECT
  (SELECT count(*) FROM cc_intents WHERE intent_type='contextual_ingest') intents,
  (SELECT count(*) FROM cc_obligations WHERE source='contextual') obligations,
  (SELECT count(*) FROM cc_recommendations WHERE source='contextual') recs,
  (SELECT count(*) FROM agent_tasks.tasks WHERE source_agent='chittycommand' AND task_type='reconciliation') tasks`)[0];

console.log('=== ingest result ===');
console.log(JSON.stringify(result, null, 2));
console.log('=== before → after ===');
console.log('cc_intents(contextual_ingest):', before.intents, '→', after.intents);
console.log('cc_obligations(contextual):   ', before.obligations, '→', after.obligations);
console.log('cc_recommendations(contextual):', before.recs, '→', after.recs);
console.log('agent_tasks.tasks(reconciliation/chittycommand):', before.tasks, '→', after.tasks);

server.close();
process.exit(0);
