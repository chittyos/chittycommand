import { Hono } from 'hono';
import type { Env } from '../index';
import type { AuthVariables } from '../middleware/auth';
import { getDb } from '../lib/db';
import { evidenceClient, ledgerClient } from '../lib/integrations';

export const timelineRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

interface TimelineEvent {
  id: string;
  date: string;
  type: 'fact' | 'deadline' | 'dispute' | 'docket' | 'document';
  title: string;
  description?: string;
  source: string;
  metadata?: Record<string, unknown>;
}

// GET /cases/:caseId/timeline — unified case timeline
timelineRoutes.get('/cases/:caseId/timeline', async (c) => {
  const { caseId } = c.req.param();
  const startDate = c.req.query('start');
  const endDate = c.req.query('end');

  const events: TimelineEvent[] = [];

  // 1. Fetch enriched facts from ChittyEvidence
  const evidence = evidenceClient(c.env);
  if (evidence) {
    try {
      const facts = startDate && endDate
        ? await evidence.getFactsByDateRange(caseId, startDate, endDate)
        : await evidence.getEnrichedFacts(caseId);

      if (facts) {
        for (const fact of facts) {
          if (!fact.fact_date) continue;
          events.push({
            id: `fact:${fact.id}`,
            date: fact.fact_date,
            type: 'fact',
            title: fact.fact_text.slice(0, 120) + (fact.fact_text.length > 120 ? '...' : ''),
            description: fact.source_quote || undefined,
            source: 'chittyevidence',
            metadata: {
              factType: fact.fact_type,
              confidence: fact.confidence,
              verificationStatus: fact.verification_status,
              entities: fact.entities,
              amounts: fact.amounts,
              documentId: fact.document_id,
            },
          });
        }
      }
    } catch (err) {
      console.error('[timeline] evidence facts error:', err);
    }
  }

  // 2. Fetch legal deadlines from ChittyCommand DB
  const sql = getDb(c.env);
  try {
    const deadlines = await sql`
      SELECT id, title, description, deadline_date, deadline_type, status, urgency_score
      FROM cc_legal_deadlines
      WHERE case_ref = ${caseId}
      ${startDate ? sql`AND deadline_date >= ${startDate}` : sql``}
      ${endDate ? sql`AND deadline_date <= ${endDate}` : sql``}
      ORDER BY deadline_date ASC
    `;
    for (const d of deadlines) {
      events.push({
        id: `deadline:${d.id}`,
        date: d.deadline_date,
        type: 'deadline',
        title: d.title,
        description: d.description || undefined,
        source: 'chittycommand',
        metadata: {
          deadlineType: d.deadline_type,
          status: d.status,
          urgencyScore: d.urgency_score,
        },
      });
    }
  } catch (err) {
    console.error('[timeline] deadlines error:', err);
  }

  // 3. Fetch dispute milestones
  try {
    const disputes = await sql`
      SELECT id, title, status, priority, domain, created_at, updated_at, metadata
      FROM cc_disputes
      WHERE metadata->>'case_ref' = ${caseId}
         OR metadata->>'ledger_case_id' = ${caseId}
      ORDER BY created_at ASC
    `;
    for (const d of disputes) {
      events.push({
        id: `dispute:${d.id}`,
        date: d.created_at,
        type: 'dispute',
        title: `[${d.domain || 'general'}] ${d.title}`,
        description: `Status: ${d.status}, Priority: ${d.priority}`,
        source: 'chittycommand',
        metadata: {
          status: d.status,
          priority: d.priority,
          domain: d.domain,
        },
      });
    }
  } catch (err) {
    console.error('[timeline] disputes error:', err);
  }

  // 4. Fetch evidence documents from ChittyLedger
  const ledger = ledgerClient(c.env);
  if (ledger) {
    try {
      const docs = await ledger.getEvidenceByCase(caseId);
      for (const doc of docs) {
        const uploadDate = (doc.created_at || doc.uploaded_at || '') as string;
        if (!uploadDate) continue;
        events.push({
          id: `doc:${doc.id}`,
          date: uploadDate,
          type: 'document',
          title: `Document: ${doc.filename || doc.title || 'Untitled'}`,
          description: (doc.description as string) || undefined,
          source: 'chittyledger',
          metadata: {
            fileType: doc.file_type,
            evidenceTier: doc.evidence_tier,
          },
        });
      }
    } catch (err) {
      console.error('[timeline] ledger docs error:', err);
    }
  }

  // Sort by date ascending
  events.sort((a, b) => a.date.localeCompare(b.date));

  return c.json({
    caseId,
    eventCount: events.length,
    dateRange: {
      earliest: events[0]?.date || null,
      latest: events[events.length - 1]?.date || null,
    },
    sources: {
      facts: events.filter(e => e.type === 'fact').length,
      deadlines: events.filter(e => e.type === 'deadline').length,
      disputes: events.filter(e => e.type === 'dispute').length,
      documents: events.filter(e => e.type === 'document').length,
    },
    events,
  });
});

// GET /cases/:caseId/facts — proxy to ChittyEvidence enriched facts
timelineRoutes.get('/cases/:caseId/facts', async (c) => {
  const { caseId } = c.req.param();
  const evidence = evidenceClient(c.env);
  if (!evidence) return c.json({ error: 'ChittyEvidence not configured' }, 503);

  const facts = await evidence.getEnrichedFacts(caseId);
  return c.json({ caseId, facts: facts || [] });
});

// GET /cases/:caseId/contradictions — proxy to ChittyEvidence
timelineRoutes.get('/cases/:caseId/contradictions', async (c) => {
  const { caseId } = c.req.param();
  const evidence = evidenceClient(c.env);
  if (!evidence) return c.json({ error: 'ChittyEvidence not configured' }, 503);

  const contradictions = await evidence.getContradictions(caseId);
  return c.json({ caseId, contradictions: contradictions || [] });
});

// GET /cases/:caseId/pending-facts — facts awaiting review
timelineRoutes.get('/cases/:caseId/pending-facts', async (c) => {
  const { caseId } = c.req.param();
  const limit = parseInt(c.req.query('limit') || '50');
  const evidence = evidenceClient(c.env);
  if (!evidence) return c.json({ error: 'ChittyEvidence not configured' }, 503);

  const pending = await evidence.getPendingFacts(caseId, limit);
  return c.json({ caseId, pending: pending || [] });
});
