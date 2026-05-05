import { Hono } from 'hono';
import type { Env } from '../index';
import { getDb } from '../lib/db';

/** Chunked base64 encoding — avoids stack overflow on files >64KB */
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

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

// Upload document via ChittyStorage (content-addressed, entity-linked)
documentRoutes.post('/upload', async (c) => {
  const formData = await c.req.formData();
  const file = formData.get('file') as unknown as File | null;
  const entitySlug = (formData.get('entity_slug') as string) ?? '';
  const origin = (formData.get('origin') as string) ?? 'first-party';
  if (!file || typeof file === 'string') return c.json({ error: 'No file provided' }, 400);

  if (!ALLOWED_TYPES.has(file.type)) {
    return c.json({ error: 'Unsupported file type', allowed: [...ALLOWED_TYPES] }, 400);
  }
  if (file.size > MAX_FILE_SIZE) {
    return c.json({ error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)` }, 400);
  }

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const sql = getDb(c.env);

  // Hash locally for chitty_id generation (temporary until ChittyIdentity integration)
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
  const contentHash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
  const chittyId = `scan-${contentHash.slice(0, 12)}`;

  // Submit to ChittyStorage via service binding
  if (c.env.SVC_STORAGE) {
    try {
      const content_base64 = uint8ToBase64(bytes);
      const storageRes = await c.env.SVC_STORAGE.fetch('https://internal/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: 'storage_ingest',
            arguments: {
              chitty_id: chittyId,
              filename: safeName,
              content_base64,
              mime_type: file.type,
              source_platform: 'chittycommand',
              origin,
              copyright: '©2026_IT-CAN-BE-LLC_ALL-RIGHTS-RESERVED',
              entity_slugs: entitySlug ? [entitySlug] : [],
            },
          },
          id: 1,
        }),
      });
      // MCP response - extract result
      const mcp = await storageRes.json() as any;
      const result = mcp?.result?.content?.[0]?.text;
      if (result) {
        const parsed = JSON.parse(result);
        // Track in local cc_documents for ChittyCommand UI
        const [doc] = await sql`
          INSERT INTO cc_documents (doc_type, source, filename, r2_key, processing_status, metadata)
          VALUES ('upload', 'chittycommand', ${safeName}, ${parsed.r2_key ?? `sha256/${contentHash}`}, 'synced',
            ${JSON.stringify({ content_hash: contentHash, storage_chitty_id: chittyId, deduplicated: parsed.deduplicated })}::jsonb)
          RETURNING *
        `;
        return c.json({ ...doc, content_hash: contentHash, storage: parsed }, 201);
      }
    } catch (err) {
      console.error('[documents] ChittyStorage ingest failed, falling back to direct R2:', err);
    }
    // If we reach here, ChittyStorage either isn't bound or returned unparseable result — fall through to direct R2
    console.warn('[documents] Using legacy R2 fallback for:', safeName);
  }

  // Fallback: direct R2 (legacy path — remove once SVC_STORAGE is confirmed stable)
  const r2Key = `sha256/${contentHash}`;
  await c.env.DOCUMENTS.put(r2Key, bytes, {
    httpMetadata: { contentType: file.type },
    customMetadata: { filename: safeName, source: 'chittycommand' },
  });
  const [doc] = await sql`
    INSERT INTO cc_documents (doc_type, source, filename, r2_key, processing_status)
    VALUES ('upload', 'manual', ${safeName}, ${r2Key}, 'pending')
    RETURNING *
  `;
  return c.json(doc, 201);
});

// Batch upload via ChittyStorage
documentRoutes.post('/upload/batch', async (c) => {
  const formData = await c.req.formData();
  const files = formData.getAll('files') as unknown as File[];
  const entitySlug = (formData.get('entity_slug') as string) ?? '';
  if (!files.length) return c.json({ error: 'No files provided' }, 400);
  if (files.length > 20) return c.json({ error: 'Maximum 20 files per batch' }, 400);

  const sql = getDb(c.env);
  const results: { filename: string; status: 'ok' | 'skipped' | 'error'; error?: string; content_hash?: string }[] = [];

  for (const file of files) {
    if (typeof file === 'string') { results.push({ filename: '(invalid)', status: 'error', error: 'Not a file' }); continue; }
    if (!ALLOWED_TYPES.has(file.type)) { results.push({ filename: file.name, status: 'error', error: `Unsupported: ${file.type}` }); continue; }
    if (file.size > MAX_FILE_SIZE) { results.push({ filename: file.name, status: 'error', error: 'Too large' }); continue; }

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
      const contentHash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

      const chittyId = `scan-${contentHash.slice(0, 12)}`;
      let r2Key = `sha256/${contentHash}`;

      if (c.env.SVC_STORAGE) {
        const content_base64 = uint8ToBase64(bytes);
        const storageRes = await c.env.SVC_STORAGE.fetch('https://internal/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', method: 'tools/call',
            params: { name: 'storage_ingest', arguments: {
              chitty_id: chittyId, filename: safeName,
              content_base64, mime_type: file.type, source_platform: 'chittycommand',
              origin: 'first-party', copyright: '©2026_IT-CAN-BE-LLC_ALL-RIGHTS-RESERVED',
              entity_slugs: entitySlug ? [entitySlug] : [],
            }}, id: 1,
          }),
        });
        const mcp = await storageRes.json() as any;
        const resultText = mcp?.result?.content?.[0]?.text;
        if (resultText) {
          try {
            const parsed = JSON.parse(resultText);
            r2Key = parsed.r2_key ?? r2Key;
          } catch (parseErr) {
            console.error(`[documents] Batch: ChittyStorage mcp/error parsing for ${safeName}:`, parseErr, 'resultText:', resultText);
            results.push({ filename: safeName, status: 'error', error: 'ChittyStorage ingest failed' });
            continue;
          }
        } else {
          console.error(`[documents] Batch: ChittyStorage mcp/response missing resultText for ${safeName}:`, mcp);
          results.push({ filename: safeName, status: 'error', error: 'ChittyStorage ingest failed' });
          continue;
        }
      } else {
        await c.env.DOCUMENTS.put(r2Key, bytes, {
          httpMetadata: { contentType: file.type },
          customMetadata: { filename: safeName, source: 'chittycommand' },
        });
      }

      await sql`
        INSERT INTO cc_documents (doc_type, source, filename, r2_key, processing_status, metadata)
        VALUES ('upload', 'chittycommand', ${safeName}, ${r2Key}, 'synced',
          ${JSON.stringify({ content_hash: contentHash, storage_chitty_id: chittyId, batch: true })}::jsonb)
        ON CONFLICT (r2_key) DO NOTHING
      `;
      results.push({ filename: safeName, status: 'ok', content_hash: contentHash });
    } catch (err) {
      results.push({ filename: safeName, status: 'error', error: String(err) });
    }
  }

  return c.json({ total: files.length, succeeded: results.filter(r => r.status === 'ok').length, results }, 201);
});

// Identify missing documents / coverage gaps
documentRoutes.get('/gaps', async (c) => {
  const sql = getDb(c.env);
  const payees = await sql`SELECT DISTINCT payee, category, recurrence FROM cc_obligations WHERE status IN ('pending', 'overdue') ORDER BY payee`;
  const docs = await sql`SELECT filename, created_at FROM cc_documents ORDER BY created_at DESC`;

  const gaps: { payee: string; category: string; recurrence: string | null; has_document: boolean; last_upload: string | null }[] = [];
  for (const p of payees) {
    const payeeLower = (p.payee as string).toLowerCase().replace(/[^a-z0-9]/g, '');
    const match = docs.find((d: any) => d.filename && (d.filename as string).toLowerCase().replace(/[^a-z0-9]/g, '').includes(payeeLower));
    gaps.push({ payee: p.payee as string, category: p.category as string, recurrence: p.recurrence as string | null, has_document: !!match, last_upload: match ? (match.created_at as string) : null });
  }
  return c.json({ total_payees: gaps.length, covered: gaps.length - gaps.filter(g => !g.has_document).length, missing: gaps.filter(g => !g.has_document).length, gaps });
});
