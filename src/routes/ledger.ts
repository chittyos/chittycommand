import { Hono } from 'hono';
import type { Env } from '../index';
import { ledgerClient } from '../lib/integrations';

export const ledgerRoutes = new Hono<{ Bindings: Env }>();

// GET /api/v1/ledger/evidence?case_id=...
ledgerRoutes.get('/ledger/evidence', async (c) => {
  const caseId = c.req.query('case_id');
  if (!caseId) return c.json({ error: 'Missing query param: case_id' }, 400);
  const ledger = ledgerClient(c.env);
  if (!ledger) return c.json({ error: 'ChittyLedger not configured' }, 503);
  const items = await ledger.getEvidenceByCase(caseId);
  return c.json({ case_id: caseId, evidence: items });
});

// POST /api/v1/ledger/record-custody { evidence_id, action, notes? }
ledgerRoutes.post('/ledger/record-custody', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const evidenceId = String((body?.evidence_id ?? '')).trim();
  const action = String((body?.action ?? '')).trim();
  const notes = (body?.notes as string | undefined) || undefined;
  if (!evidenceId || !action) return c.json({ error: 'Missing fields: evidence_id, action' }, 400);
  // @ts-expect-error app-level vars
  const userId = (c.get('userId') as string | undefined) || 'api-client';
  const ledger = ledgerClient(c.env);
  if (!ledger) return c.json({ error: 'ChittyLedger not configured' }, 503);
  const result = await ledger.addCustodyEntry({ evidenceId, action, performedBy: userId, notes });
  return c.json({ ok: !!result, result });
});

