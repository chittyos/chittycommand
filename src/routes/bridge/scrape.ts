import { Hono } from 'hono';
import type { Env } from '../../index';
import type { AuthVariables } from '../../middleware/auth';
import { getDb } from '../../lib/db';
import { scrapeClient } from '../../lib/integrations';
import { courtDocketScrapeSchema } from '../../lib/validators';
import { syncCourtDocketCase, type CourtDocketCaseResult } from '../../lib/court-docket';

export const scrapeRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// ── ChittyScrape ─────────────────────────────────────────────

/**
 * Read back the court docket result ChittyScrape has stored for one case and
 * insert its dated entries. No live scrape is triggered.
 */
scrapeRoutes.post('/court-docket', async (c) => {
  if (!c.env.CHITTYSCRAPE_URL) return c.json({ error: 'ChittyScrape not configured' }, 503);

  const token = await c.env.COMMAND_KV.get('scrape:service_token');
  if (!token) return c.json({ error: 'Scrape service token not configured' }, 503);

  const parsed = courtDocketScrapeSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Validation failed', issues: parsed.error.issues }, 400);
  // No fallback. The schema requires caseNumber; an absent matter is a 400.
  const targetCase = parsed.data.caseNumber;

  const sql = getDb(c.env);
  let result: CourtDocketCaseResult;
  try {
    result = await syncCourtDocketCase(c.env, sql, targetCase, token);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sql`INSERT INTO cc_sync_log (source, sync_type, status, records_synced, error_message)
      VALUES ('court_docket', 'readback', 'error', 0, ${message})`;
    return c.json({ error: 'court_docket_readback_failed', message }, 502);
  }

  await sql`INSERT INTO cc_sync_log (source, sync_type, status, records_synced, error_message)
    VALUES ('court_docket', 'readback', ${result.ok ? 'completed' : 'error'}, ${result.ok ? result.inserted : 0}, ${result.ok ? null : result.error})`;

  if (!result.ok) {
    return c.json({ error: result.error, caseNumber: targetCase, ...(result.scrapedAt ? { scrapedAt: result.scrapedAt } : {}) }, 404);
  }
  return c.json({ source: 'court_docket', ...result });
});

/** Trigger Cook County tax scrape for all properties */
scrapeRoutes.post('/cook-county-tax', async (c) => {
  const scrape = scrapeClient(c.env);
  if (!scrape) return c.json({ error: 'ChittyScrape not configured' }, 503);

  const token = await c.env.COMMAND_KV.get('scrape:service_token');
  if (!token) return c.json({ error: 'Scrape service token not configured' }, 503);

  const sql = getDb(c.env);
  const properties = await sql`SELECT id, address, unit, tax_pin, metadata FROM cc_properties WHERE tax_pin IS NOT NULL`;

  const results = [];
  for (const prop of properties) {
    const result = await scrape.scrapeCookCountyTax(prop.tax_pin as string, token);
    results.push({ pin: prop.tax_pin, result });

    if (result?.success && result.data) {
      await sql`
        UPDATE cc_properties SET
          annual_tax = ${result.data.totalTax},
          metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ tax_year: result.data.taxYear, tax_installments: result.data.installments, last_tax_scrape: new Date().toISOString() })}::jsonb,
          updated_at = NOW()
        WHERE id = ${prop.id}
      `;
    }

    await sql`INSERT INTO cc_sync_log (source, sync_type, status, records_synced, error_message)
      VALUES ('cook_county_tax', 'scrape', ${result?.success ? 'success' : 'error'}, ${result?.success ? 1 : 0}, ${result?.error || null})`;
  }

  return c.json({ properties_scraped: properties.length, results });
});

/** Trigger Mr. Cooper scrape */
scrapeRoutes.post('/mr-cooper', async (c) => {
  const scrape = scrapeClient(c.env);
  if (!scrape) return c.json({ error: 'ChittyScrape not configured' }, 503);

  const token = await c.env.COMMAND_KV.get('scrape:service_token');
  if (!token) return c.json({ error: 'Scrape service token not configured' }, 503);

  const result = await scrape.scrapeMrCooper('addison', token);

  const sql = getDb(c.env);
  await sql`INSERT INTO cc_sync_log (source, sync_type, status, records_synced, error_message)
    VALUES ('mr_cooper', 'scrape', ${result?.success ? 'success' : 'error'}, ${result?.success ? 1 : 0}, ${result?.error || null})`;

  if (result?.success && result.data) {
    await sql`
      UPDATE cc_obligations SET
        amount_due = ${result.data.monthlyPayment},
        metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
          mortgage_balance: result.data.currentBalance,
          escrow_balance: result.data.escrowBalance,
          interest_rate: result.data.interestRate,
          payoff_amount: result.data.payoffAmount,
          last_scrape: new Date().toISOString(),
        })}::jsonb,
        updated_at = NOW()
      WHERE payee ILIKE '%Mr. Cooper%' AND payee ILIKE '%Addison%'
    `;
  }

  return c.json({ source: 'mr_cooper', result });
});
