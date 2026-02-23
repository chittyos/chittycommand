import { Hono } from 'hono';
import type { Env } from '../index';
import { getDb } from '../lib/db';
import { ledgerClient } from '../lib/integrations';

export const documentRoutes = new Hono<{ Bindings: Env }>();

documentRoutes.get('/', async (c) => {
  const sql = getDb(c.env);
  const docs = await sql`SELECT * FROM cc_documents ORDER BY created_at DESC LIMIT 50`;
  return c.json(docs);
});

const ALLOWED_TYPES = new Set([
  'application/pdf',
  'image/png', 'image/jpeg', 'image/webp',
  'text/csv', 'text/plain',
]);
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB

// Upload document to R2 and create DB record
documentRoutes.post('/upload', async (c) => {
  const formData = await c.req.formData();
  const file = formData.get('file') as unknown as File | null;
  if (!file || typeof file === 'string') return c.json({ error: 'No file provided' }, 400);

  if (!ALLOWED_TYPES.has(file.type)) {
    return c.json({ error: 'Unsupported file type', allowed: [...ALLOWED_TYPES] }, 400);
  }
  if (file.size > MAX_FILE_SIZE) {
    return c.json({ error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)` }, 400);
  }

  // Sanitize filename: keep only alphanumeric, dash, underscore, dot
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const sql = getDb(c.env);
  const r2Key = `documents/${Date.now()}_${safeName}`;

  // Store in R2
  await c.env.DOCUMENTS.put(r2Key, file.stream(), {
    httpMetadata: { contentType: file.type },
  });

  // Create DB record
  const [doc] = await sql`
    INSERT INTO cc_documents (doc_type, source, filename, r2_key, processing_status)
    VALUES ('upload', 'manual', ${safeName}, ${r2Key}, 'pending')
    RETURNING *
  `;

  // Fire-and-forget: push to ChittyLedger evidence pipeline
  const ledger = ledgerClient(c.env);
  if (ledger) {
    ledger.createEvidence({
      filename: safeName,
      fileType: file.type,
      fileSize: String(file.size),
      description: `Uploaded via ChittyCommand`,
      evidenceTier: 'BUSINESS_RECORDS',
    }).then((ev) => {
      if (ev?.id) {
        sql`UPDATE cc_documents SET metadata = jsonb_build_object('ledger_evidence_id', ${ev.id}), processing_status = 'synced' WHERE id = ${doc.id}`.catch(() => {});
      }
    }).catch(() => {});
  }

  return c.json(doc, 201);
});

// Batch upload multiple documents (with dedup)
documentRoutes.post('/upload/batch', async (c) => {
  const formData = await c.req.formData();
  const files = formData.getAll('files') as unknown as File[];
  if (!files.length) return c.json({ error: 'No files provided' }, 400);
  if (files.length > 20) return c.json({ error: 'Maximum 20 files per batch' }, 400);

  const sql = getDb(c.env);

  // Fetch existing filenames for dedup check
  const safeNames = files.map((f) => typeof f === 'string' ? '' : f.name.replace(/[^a-zA-Z0-9._-]/g, '_'));
  const existing = await sql`SELECT filename FROM cc_documents WHERE filename = ANY(${safeNames})`;
  const existingSet = new Set(existing.map((r: any) => r.filename));

  const results: { filename: string; status: 'ok' | 'skipped' | 'error'; error?: string; doc?: any }[] = [];

  for (const file of files) {
    if (typeof file === 'string') {
      results.push({ filename: '(invalid)', status: 'error', error: 'Not a file' });
      continue;
    }
    if (!ALLOWED_TYPES.has(file.type)) {
      results.push({ filename: file.name, status: 'error', error: `Unsupported type: ${file.type}` });
      continue;
    }
    if (file.size > MAX_FILE_SIZE) {
      results.push({ filename: file.name, status: 'error', error: 'File too large (max 25MB)' });
      continue;
    }

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');

    // Dedup: skip if this filename was already uploaded
    if (existingSet.has(safeName)) {
      results.push({ filename: safeName, status: 'skipped', error: 'Already uploaded' });
      continue;
    }

    const r2Key = `documents/${Date.now()}_${safeName}`;

    try {
      await c.env.DOCUMENTS.put(r2Key, file.stream(), {
        httpMetadata: { contentType: file.type },
      });
      const [doc] = await sql`
        INSERT INTO cc_documents (doc_type, source, filename, r2_key, processing_status)
        VALUES ('upload', 'manual', ${safeName}, ${r2Key}, 'pending')
        RETURNING *
      `;
      existingSet.add(safeName); // prevent dupes within same batch
      results.push({ filename: safeName, status: 'ok', doc });
    } catch (err) {
      results.push({ filename: safeName, status: 'error', error: String(err) });
    }
  }

  const succeeded = results.filter((r) => r.status === 'ok').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  return c.json({ total: files.length, succeeded, skipped, failed: files.length - succeeded - skipped, results }, 201);
});

// Identify missing documents / coverage gaps
documentRoutes.get('/gaps', async (c) => {
  const sql = getDb(c.env);

  // All obligation payees that should have statements
  const payees = await sql`
    SELECT DISTINCT payee, category, recurrence
    FROM cc_obligations
    WHERE status IN ('pending', 'overdue')
    ORDER BY payee
  `;

  // Documents uploaded per payee (match by filename containing payee name)
  const docs = await sql`SELECT filename, created_at FROM cc_documents ORDER BY created_at DESC`;

  const gaps: { payee: string; category: string; recurrence: string | null; has_document: boolean; last_upload: string | null }[] = [];

  for (const p of payees) {
    const payeeLower = (p.payee as string).toLowerCase().replace(/[^a-z0-9]/g, '');
    const match = docs.find((d: any) =>
      d.filename && (d.filename as string).toLowerCase().replace(/[^a-z0-9]/g, '').includes(payeeLower)
    );
    gaps.push({
      payee: p.payee as string,
      category: p.category as string,
      recurrence: p.recurrence as string | null,
      has_document: !!match,
      last_upload: match ? (match.created_at as string) : null,
    });
  }

  const missing = gaps.filter((g) => !g.has_document);
  return c.json({ total_payees: gaps.length, covered: gaps.length - missing.length, missing: missing.length, gaps });
});
