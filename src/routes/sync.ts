import { Hono } from 'hono';
import type { Env } from '../index';
import { getDb } from '../lib/db';
import { matchTransactions } from '../lib/matcher';
import { syncMercury, syncPlaid, syncFinance, syncCourtDocket, syncMrCooper, syncCookCountyTax, syncPortal } from '../lib/cron';

export const syncRoutes = new Hono<{ Bindings: Env }>();

// Get sync status for all sources
syncRoutes.get('/status', async (c) => {
  const sql = getDb(c.env);
  const statuses = await sql`
    SELECT DISTINCT ON (source) source, sync_type, status, records_synced, error_message, started_at, completed_at
    FROM cc_sync_log ORDER BY source, started_at DESC
  `;
  return c.json(statuses);
});

// Trigger manual sync for a source
syncRoutes.post('/trigger/:source', async (c) => {
  const source = c.req.param('source');
  const sql = getDb(c.env);

  const validSources = [
    'mercury', 'plaid', 'chittyfinance',
    'wave', 'stripe', 'turbotenant', 'chittyrental',
    'court_docket', 'mr_cooper', 'cook_county_tax',
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
