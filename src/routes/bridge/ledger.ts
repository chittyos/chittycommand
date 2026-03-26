import { Hono } from 'hono';
import type { Env } from '../../index';
import type { AuthVariables } from '../../middleware/auth';
import { getDb } from '../../lib/db';
import { evidenceClient, ledgerClient } from '../../lib/integrations';
import { recordActionSchema } from '../../lib/validators';

export const ledgerBridgeRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// ── Evidence Sync (via ChittyEvidence) ────────────────────────

/** Push all unsynced documents to ChittyEvidence pipeline */
ledgerBridgeRoutes.post('/sync-documents', async (c) => {
  const evidence = evidenceClient(c.env);
  if (!evidence) return c.json({ error: 'ChittyEvidence not configured' }, 503);

  const sql = getDb(c.env);
  const unsynced = await sql`
    SELECT * FROM cc_documents
    WHERE processing_status = 'pending'
    AND (metadata->>'ledger_evidence_id') IS NULL
    ORDER BY created_at ASC
    LIMIT 50
  `;

  let synced = 0;
  let failed = 0;
  for (const doc of unsynced) {
    const result = await evidence.submitDocument({
      filename: doc.filename || 'unknown',
      fileType: doc.doc_type || 'upload',
      description: `Uploaded via ChittyCommand: ${doc.filename}`,
      evidenceTier: 'BUSINESS_RECORDS',
    });

    if (result?.id) {
      await sql`
        UPDATE cc_documents SET
          metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ ledger_evidence_id: result.id })}::jsonb,
          processing_status = 'synced'
        WHERE id = ${doc.id}
      `;
      synced++;
    } else {
      console.warn(`[bridge/ledger] sync-documents: submission failed for doc ${doc.id} (${doc.filename})`);
      failed++;
    }
  }

  // Also log the sync event to ChittyLedger audit trail
  const ledger = ledgerClient(c.env);
  if (ledger && synced > 0) {
    ledger.addEntry({
      entityType: 'audit',
      action: 'evidence:sync-documents',
      actor: 'chittycommand',
      actorType: 'service',
      metadata: { total: unsynced.length, synced, failed },
    }).catch((err) => console.error('[bridge/ledger] Audit log for sync-documents failed:', err));
  }

  return c.json({ total: unsynced.length, synced, failed, message: `Synced ${synced} documents to ChittyEvidence` });
});

/** Push disputes to ChittyLedger as audit entries */
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
    const caseRef = `CC-DISPUTE-${(dispute.id as string).slice(0, 8)}`;
    const entryResult = await ledger.addEntry({
      entityType: 'audit',
      entityId: caseRef,
      action: 'dispute:created',
      actor: 'chittycommand',
      actorType: 'service',
      metadata: {
        title: dispute.title,
        description: dispute.description,
        caseType: 'CIVIL',
      },
    });

    if (entryResult?.id) {
      await sql`
        UPDATE cc_disputes SET
          metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ ledger_case_id: caseRef, ledger_entry_id: entryResult.id })}::jsonb
        WHERE id = ${dispute.id}
      `;
      synced++;
    }
  }

  return c.json({ total: unsynced.length, synced, message: `Synced ${synced} disputes to ChittyLedger` });
});

/** Record an action in ChittyEvidence chain of custody */
ledgerBridgeRoutes.post('/record-action', async (c) => {
  const evidence = evidenceClient(c.env);
  if (!evidence) return c.json({ error: 'ChittyEvidence not configured' }, 503);

  const parsed = recordActionSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Invalid request', details: parsed.error.issues }, 400);

  const body = parsed.data;
  const result = await evidence.addCustodyEntry(body.evidence_id, {
    action: body.action,
    performedBy: 'chittycommand',
    location: 'ChittyCommand Dashboard',
    notes: body.notes,
  });

  if (!result) return c.json({ recorded: false, error: 'ChittyEvidence custody write failed' }, 502);
  return c.json({ recorded: true, result });
});
