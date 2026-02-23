import { Hono } from 'hono';
import type { Env } from '../index';
import { getDb } from '../lib/db';
import { matchTransactions } from '../lib/matcher';

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
    'mercury', 'wave', 'stripe', 'turbotenant', 'chittyrental',
    'comed', 'peoples_gas', 'xfinity', 'mr_cooper',
    'citi', 'home_depot', 'lowes',
    'cook_county_tax', 'court_docket',
  ];

  if (!validSources.includes(source)) {
    return c.json({ error: `Invalid source. Valid: ${validSources.join(', ')}` }, 400);
  }

  const [log] = await sql`
    INSERT INTO cc_sync_log (source, sync_type, status)
    VALUES (${source}, 'manual', 'started')
    RETURNING *
  `;

  // TODO: Dispatch actual sync job based on source
  // For now, just log it
  return c.json({ message: `Sync triggered for ${source}`, sync_id: log.id });
});

// Run transaction-to-obligation matching
syncRoutes.post('/match', async (c) => {
  const sql = getDb(c.env);
  const result = await matchTransactions(sql);
  return c.json(result);
});
