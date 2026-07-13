import { Hono } from 'hono';
import type { Env } from '../index';
import { getDb } from '../lib/db';
import { matchTransactions } from '../lib/matcher';
import { syncMercury, syncPlaid, syncFinance, syncCourtDocket, syncMrCooper, syncCookCountyTax, syncPortal, syncGovernanceCompliance } from '../lib/cron';
import type { AuthVariables } from '../middleware/auth';

export const syncRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// Get sync status for all sources
syncRoutes.get('/status', async (c) => {
  const sql = getDb(c.env);
  const statuses = await sql`
    SELECT DISTINCT ON (source) source, sync_type, status, records_synced, error_message, started_at, completed_at
    FROM cc_sync_log ORDER BY source, started_at DESC
  `;
  return c.json(statuses);
});

// Get sync status for a specific execution ID
syncRoutes.get('/status/:sync_id', async (c) => {
  const syncId = c.req.param('sync_id');
  const sql = getDb(c.env);

  const [log] = await sql`
    SELECT id, source, sync_type, status, records_synced, error_message, started_at, completed_at
    FROM cc_sync_log WHERE id = ${syncId}
  `;
  
  if (!log) return c.json({ error: 'Sync log not found' }, 404);

  // Authorization check
  const scopes = c.get('scopes') || [];
  const requiredScope = `chittycommand:sync:${log.source}`;
  if (!scopes.includes(requiredScope) && !scopes.includes('chittycommand:sync:*')) {
    return c.json({ error: `Insufficient scope to view status for source ${log.source}` }, 403);
  }

  // Determine if it's a terminal state
  const isTerminal = ['completed', 'error', 'skipped'].includes(log.status);

  // Bounded polling info for the client
  const response = {
    ...log,
    is_terminal: isTerminal,
    poll_interval_ms: isTerminal ? null : 2000,
  };

  return c.json(response);
});

// Trigger manual sync for a source
syncRoutes.post('/trigger/:source', async (c) => {
  const source = c.req.param('source');
  const sql = getDb(c.env);

  // Scope validation
  const scopes = c.get('scopes') || [];
  const requiredScope = `chittycommand:sync:${source}`;
  
  // Financial sources like Mercury are highly restricted; no general admin bypass.
  let isAuthorized = false;
  if (['mercury', 'plaid', 'chittyfinance'].includes(source)) {
    isAuthorized = scopes.includes(requiredScope);
  } else {
    isAuthorized = scopes.includes(requiredScope) || scopes.includes('chittycommand:sync:*') || scopes.includes('admin') || scopes.includes('*');
  }

  if (!isAuthorized) {
    return c.json({ error: `Insufficient scope: ${requiredScope} required explicitly for this source` }, 403);
  }

  const validSources = [
    'mercury', 'plaid', 'chittyfinance',
    'wave', 'stripe', 'turbotenant', 'chittyrental',
    'court_docket', 'mr_cooper', 'cook_county_tax',
    'sos_status', 'recorder_filings', 'assessor_check',
    'comed', 'peoples_gas', 'xfinity',
    'citi', 'home_depot', 'lowes',
  ];

  if (!validSources.includes(source)) {
    return c.json({ error: `Invalid source. Valid: ${validSources.join(', ')}` }, 400);
  }

  const [log] = await sql`
    INSERT INTO cc_sync_log (source, sync_type, status)
    VALUES (${source}, 'manual', 'started')
    RETURNING *
  `;

  // Sources that flow through ChittyFinance aggregation
  const chittyFinanceAliases = ['wave', 'stripe', 'turbotenant', 'chittyrental'];

  // Portal sources routed through ChittyRouter gateway
  const portalSources = ['comed', 'peoples_gas', 'xfinity', 'citi', 'home_depot', 'lowes'];

  const dispatchers: Record<string, () => Promise<number>> = {
    mercury: () => syncMercury(c.env, sql),
    plaid: () => syncPlaid(c.env, sql),
    chittyfinance: () => syncFinance(c.env, sql),
    court_docket: () => syncCourtDocket(c.env, sql),
    mr_cooper: () => syncMrCooper(c.env, sql),
    cook_county_tax: () => syncCookCountyTax(c.env, sql),
    sos_status: () => syncGovernanceCompliance(c.env, sql),
    recorder_filings: () => syncGovernanceCompliance(c.env, sql),
    assessor_check: () => syncGovernanceCompliance(c.env, sql),
  };

  // Resolve aliases and portal sources to their dispatcher
  let dispatcher = dispatchers[source];
  if (!dispatcher && chittyFinanceAliases.includes(source)) {
    dispatcher = dispatchers.chittyfinance;
  }
  if (!dispatcher && portalSources.includes(source)) {
    dispatcher = () => syncPortal(c.env, sql, source);
  }

  if (!dispatcher) {
    await sql`
      UPDATE cc_sync_log SET status = 'skipped', error_message = ${'No sync implementation for ' + source}, completed_at = NOW()
      WHERE id = ${log.id}
    `;
    return c.json({ message: `No sync implementation for ${source}`, sync_id: log.id, status: 'skipped' });
  }

  // Run sync in background via waitUntil if available, otherwise inline
  const run = async () => {
    try {
      const recordsSynced = await dispatcher();
      await sql`
        UPDATE cc_sync_log SET status = 'completed', records_synced = ${recordsSynced}, completed_at = NOW()
        WHERE id = ${log.id}
      `;
    } catch (err) {
      await sql`
        UPDATE cc_sync_log SET status = 'error', error_message = ${String(err)}, completed_at = NOW()
        WHERE id = ${log.id}
      `.catch(() => {});
    }
  };

  const ctx = c.executionCtx;
  if (ctx?.waitUntil) {
    ctx.waitUntil(run());
    return c.json({ message: `Sync dispatched for ${source}`, sync_id: log.id, status: 'dispatched' });
  }

  await run();
  const [result] = await sql`SELECT status, records_synced, error_message FROM cc_sync_log WHERE id = ${log.id}`;
  return c.json({ message: `Sync completed for ${source}`, sync_id: log.id, ...result });
});

// Run transaction-to-obligation matching
syncRoutes.post('/match', async (c) => {
  const sql = getDb(c.env);
  const result = await matchTransactions(sql);
  return c.json(result);
});
