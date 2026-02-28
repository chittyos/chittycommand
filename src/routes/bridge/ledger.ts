import { Hono } from 'hono';
import type { Env } from '../../index';
import type { AuthVariables } from '../../middleware/auth';
import { getDb } from '../../lib/db';
import { ledgerClient } from '../../lib/integrations';
import { recordActionSchema } from '../../lib/validators';

export const ledgerBridgeRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// ── ChittyLedger Sync ────────────────────────────────────────

/** Push all unsynced documents to ChittyLedger as evidence */
ledgerBridgeRoutes.post('/sync-documents', async (c) => {
  const ledger = ledgerClient(c.env);
  if (!ledger) return c.json({ error: 'ChittyLedger not configured' }, 503);

  const sql = getDb(c.env);
  const unsynced = await sql`
    SELECT * FROM cc_documents
    WHERE processing_status = 'pending'
    AND (metadata->>'ledger_evidence_id') IS NULL
    ORDER BY created_at ASC
    LIMIT 50
  `;

  let synced = 0;
  for (const doc of unsynced) {
    const evidence = await ledger.createEvidence({
      filename: doc.filename || 'unknown',
      fileType: doc.doc_type || 'upload',
      description: `Uploaded via ChittyCommand: ${doc.filename}`,
      evidenceTier: 'BUSINESS_RECORDS',
    });

    if (evidence?.id) {
      await sql`
        UPDATE cc_documents SET
          metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ ledger_evidence_id: evidence.id })}::jsonb,
          processing_status = 'synced'
        WHERE id = ${doc.id}
      `;
      synced++;
    }
  }

  return c.json({ total: unsynced.length, synced, message: `Synced ${synced} documents to ChittyLedger` });
});

/** Push disputes to ChittyLedger as cases */
ledgerBridgeRoutes.post('/sync-disputes', async (c) => {
  const ledger = ledgerClient(c.env);
  if (!ledger) return c.json({ error: 'ChittyLedger not configured' }, 503);

  const sql = getDb(c.env);
  const unsynced = await sql`
    SELECT * FROM cc_disputes
    WHERE (metadata->>'ledger_case_id') IS NULL
    ORDER BY created_at ASC
  `;

  let synced = 0;
  for (const dispute of unsynced) {
    const caseResult = await ledger.createCase({
      caseNumber: `CC-DISPUTE-${(dispute.id as string).slice(0, 8)}`,
      title: dispute.title as string,
      caseType: 'CIVIL',
      description: dispute.description as string || undefined,
    });

    if (caseResult?.id) {
      await sql`
        UPDATE cc_disputes SET
          metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ ledger_case_id: caseResult.id })}::jsonb
        WHERE id = ${dispute.id}
      `;
      synced++;
    }
  }

  return c.json({ total: unsynced.length, synced, message: `Synced ${synced} disputes to ChittyLedger` });
});

/** Record an action in ChittyLedger chain of custody */
ledgerBridgeRoutes.post('/record-action', async (c) => {
  const ledger = ledgerClient(c.env);
  if (!ledger) return c.json({ error: 'ChittyLedger not configured' }, 503);

  const parsed = recordActionSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Invalid request', details: parsed.error.issues }, 400);

  const body = parsed.data;
  const result = await ledger.addCustodyEntry({
    evidenceId: body.evidence_id,
    action: body.action,
    performedBy: 'chittycommand',
    location: 'ChittyCommand Dashboard',
    notes: body.notes,
  });

  return c.json({ recorded: !!result });
});
