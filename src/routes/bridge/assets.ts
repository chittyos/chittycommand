import { Hono } from 'hono';
import type { Env } from '../../index';
import type { AuthVariables } from '../../middleware/auth';
import { getDb } from '../../lib/db';
import { assetsClient } from '../../lib/integrations';
import { submitEvidenceSchema } from '../../lib/validators';

export const assetsBridgeRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// ── ChittyAssets ────────────────────────────────────────────

/** Sync property/asset data from ChittyAssets into cc_properties */
assetsBridgeRoutes.post('/sync-properties', async (c) => {
  const assets = assetsClient(c.env);
  if (!assets) return c.json({ error: 'ChittyAssets not configured' }, 503);

  const assetList = await assets.getAssets();
  if (!assetList) return c.json({ error: 'Failed to fetch assets from ChittyAssets' }, 502);

  const sql = getDb(c.env);
  let created = 0;
  let updated = 0;

  for (const asset of assetList) {
    if (!asset.address) continue;

    const [existing] = await sql`
      SELECT id FROM cc_properties WHERE address = ${asset.address as string} AND unit = ${(asset.unit as string) || null}
    `;

    if (existing) {
      await sql`
        UPDATE cc_properties SET
          metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ chittyassets_id: asset.id, last_synced: new Date().toISOString() })}::jsonb,
          updated_at = NOW()
        WHERE id = ${existing.id}
      `;
      updated++;
    } else {
      await sql`
        INSERT INTO cc_properties (address, unit, property_type, metadata)
        VALUES (${asset.address as string}, ${(asset.unit as string) || null}, ${(asset.propertyType as string) || null},
                ${JSON.stringify({ chittyassets_id: asset.id, source: 'chittyassets' })}::jsonb)
      `;
      created++;
    }
  }

  return c.json({ fetched: assetList.length, created, updated });
});

/** Push an action result to ChittyAssets evidence ledger */
assetsBridgeRoutes.post('/submit-evidence', async (c) => {
  const assets = assetsClient(c.env);
  if (!assets) return c.json({ error: 'ChittyAssets not configured' }, 503);

  const parsed = submitEvidenceSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Validation failed', issues: parsed.error.issues }, 400);
  const body = parsed.data;

  const result = await assets.submitEvidence({
    evidenceType: body.evidenceType,
    data: body.data,
    metadata: { ...body.metadata, submissionSource: 'ChittyCommand' },
  });

  if (!result) return c.json({ error: 'Failed to submit evidence to ChittyAssets' }, 502);

  const sql = getDb(c.env);
  await sql`
    INSERT INTO cc_actions_log (action_type, target_type, description, request_payload, response_payload, status)
    VALUES ('assets_evidence', 'evidence', ${body.evidenceType}, ${JSON.stringify(body)}::jsonb, ${JSON.stringify(result)}::jsonb, 'completed')
  `;

  return c.json({ submitted: true, chittyId: result.chittyId, trustScore: result.trustScore });
});
