/**
 * Integration tests for /workspace/studio/roux-ingest.
 *
 * Real-deps philosophy (per CLAUDE.md no-mocks rule):
 *   - JWT: real RS256 keypair generated via jose; JWKS served from a local
 *          http server; verifier configured via GCP_JWKS_URL env override.
 *          No global fetch mock — `jose` actually calls the JWKS URL.
 *   - DB:  real Neon. Skipped without DATABASE_URL (mirrors the established
 *          pattern in tests/meta/intent-lifecycle.spec.ts and
 *          tests/routes/triage-roux.spec.ts — there is no neon-branch
 *          autoprovision helper in this repo yet, and the task explicitly
 *          forbids mocks).
 *   - Storage / Router / Evidence: bindings are absent in the test env so
 *          the route's async fan-out short-circuits. The intent row itself
 *          is the contract surface we assert against.
 *
 * @canon: chittycanon://core/services/chittycommand/workspace-studio
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createServer, type Server } from 'node:http';
import { neon } from '@neondatabase/serverless';
import {
  verifyWorkspaceSystemIdToken,
  verifyWorkspaceUserIdToken,
  WorkspaceJWTError,
} from '../../src/lib/workspace-jwt';
import { workspaceStudioRoutes } from '../../src/routes/workspace-studio';
import { Hono } from 'hono';
import type { Env } from '../../src/index';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP_DB = !DATABASE_URL || process.env.SKIP_INTEGRATION === '1';
const TEST_TAG = `ws-studio-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const SA_EMAIL = 'chittyclaw@chittyops.iam.gserviceaccount.com';
const CLIENT_ID = '443939537625-a0un9jpol6gi53h7t53kbn4jic0o3c0m.apps.googleusercontent.com';

interface TestSigner {
  privateKey: CryptoKey;
  publicJwk: Record<string, unknown>;
  kid: string;
  jwksUrl: string;
  server: Server;
}

async function startJwksServer(): Promise<TestSigner> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  const kid = `test-${Date.now()}`;
  const publicJwk = { ...jwk, kid, alg: 'RS256', use: 'sig' };

  const server = createServer((req, res) => {
    if (req.url === '/certs') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys: [publicJwk] }));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'string' || !addr) throw new Error('JWKS server address missing');
  const jwksUrl = `http://127.0.0.1:${addr.port}/certs`;
  return { privateKey, publicJwk, kid, jwksUrl, server };
}

async function signTestToken(
  signer: TestSigner,
  claims: Record<string, unknown>,
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: signer.kid })
    .setIssuedAt()
    .setExpirationTime('5m')
    .setIssuer('https://accounts.google.com')
    .sign(signer.privateKey);
}

function makeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: (async (key: string, opts?: { type?: string }) => {
      const v = store.get(key);
      if (v === undefined) return null;
      if (opts && opts.type === 'json') return JSON.parse(v);
      return v;
    }) as KVNamespace['get'],
    put: (async (key: string, value: string) => {
      store.set(key, value);
    }) as KVNamespace['put'],
    delete: (async (key: string) => { store.delete(key); }) as KVNamespace['delete'],
    list: (async () => ({ keys: [], list_complete: true, cacheStatus: null })) as unknown as KVNamespace['list'],
    getWithMetadata: (async () => ({ value: null, metadata: null, cacheStatus: null })) as unknown as KVNamespace['getWithMetadata'],
  } as unknown as KVNamespace;
}

let signer: TestSigner;
let baseEnv: Pick<Env, 'COMMAND_KV'> & {
  CHITTYROUX_GCP_SA_EMAIL: string;
  CHITTYROUX_MARKETPLACE_OAUTH_CLIENT_ID: string;
  GCP_JWKS_URL: string;
};

beforeAll(async () => {
  signer = await startJwksServer();
  baseEnv = {
    COMMAND_KV: makeKv(),
    CHITTYROUX_GCP_SA_EMAIL: SA_EMAIL,
    CHITTYROUX_MARKETPLACE_OAUTH_CLIENT_ID: CLIENT_ID,
    GCP_JWKS_URL: signer.jwksUrl,
  };
  if (DATABASE_URL) {
    const sql = neon(DATABASE_URL);
    await sql`DELETE FROM cc_goals WHERE title LIKE ${TEST_TAG + '%'}`;
  }
});

afterAll(async () => {
  if (signer) await new Promise<void>((r) => signer.server.close(() => r()));
  if (DATABASE_URL) {
    const sql = neon(DATABASE_URL);
    await sql`DELETE FROM cc_goals WHERE title LIKE ${TEST_TAG + '%'}`;
  }
});

// ── JWT verification (no DB needed) ────────────────────────────────────

describe('workspace-jwt verification', () => {
  it('verifies a well-formed systemIdToken with correct SA + audience', async () => {
    const token = await signTestToken(signer, {
      sub: 'system-1',
      email: SA_EMAIL,
      aud: CLIENT_ID,
    });
    const claims = await verifyWorkspaceSystemIdToken(token, baseEnv);
    expect(claims.email).toBe(SA_EMAIL);
    expect(claims.aud).toBe(CLIENT_ID);
  });

  it('rejects a systemIdToken with wrong SA email', async () => {
    const token = await signTestToken(signer, {
      sub: 'system-1',
      email: 'attacker@evil.iam.gserviceaccount.com',
      aud: CLIENT_ID,
    });
    await expect(verifyWorkspaceSystemIdToken(token, baseEnv)).rejects.toBeInstanceOf(
      WorkspaceJWTError,
    );
  });

  it('rejects a token with wrong audience', async () => {
    const token = await signTestToken(signer, {
      sub: 'system-1',
      email: SA_EMAIL,
      aud: 'someone-elses-client-id',
    });
    await expect(verifyWorkspaceSystemIdToken(token, baseEnv)).rejects.toBeInstanceOf(
      WorkspaceJWTError,
    );
  });

  it('verifies userIdToken and extracts user email', async () => {
    const token = await signTestToken(signer, {
      sub: 'user-42',
      email: 'nick@nevershitty.com',
      aud: CLIENT_ID,
    });
    const claims = await verifyWorkspaceUserIdToken(token, baseEnv);
    expect(claims.email).toBe('nick@nevershitty.com');
  });
});

// ── Route integration (real Neon) ──────────────────────────────────────

describe.skipIf(SKIP_DB)('workspace-studio route (real Neon)', () => {
  const channelId = 'chitty:channel:workspace-studio-gmail';
  const REGISTERED_CHANNELS_JSON = JSON.stringify({
    [channelId]: {
      channel_id: channelId,
      chitty_id: channelId,
      platform: 'google_workspace',
      capabilities: ['gmail.ingest'],
      status: 'active',
    },
  });

  async function buildAuthedBody(opts: {
    messageId: string;
    subject?: string;
    disputeType?: string;
    classification?: string;
    flatShape?: boolean;
  }) {
    const sysTok = await signTestToken(signer, {
      sub: 'sys-1',
      email: SA_EMAIL,
      aud: CLIENT_ID,
    });
    const userTok = await signTestToken(signer, {
      sub: 'user-1',
      email: 'nick@nevershitty.com',
      aud: CLIENT_ID,
    });
    const inputs = opts.flatShape
      ? {
          message_id: opts.messageId,
          subject: opts.subject ?? `${TEST_TAG}-${opts.messageId}`,
          dispute_type: opts.disputeType ?? 'public',
          classification: opts.classification ?? '',
        }
      : {
          event: {
            workflow: {
              actionInvocation: {
                inputs: {
                  message_id: { stringValues: [opts.messageId] },
                  subject: { stringValues: [opts.subject ?? `${TEST_TAG}-${opts.messageId}`] },
                  dispute_type: { stringValues: [opts.disputeType ?? 'public'] },
                  classification: { stringValues: [opts.classification ?? ''] },
                },
              },
            },
          },
        };
    return {
      authorizationEventObject: {
        systemIdToken: sysTok,
        userIdToken: userTok,
        userOAuthToken: 'oauth-test',
      },
      channel_id: channelId,
      ...inputs,
    };
  }

  function buildApp() {
    const app = new Hono<{ Bindings: Env }>();
    app.route('/workspace/studio/roux-ingest', workspaceStudioRoutes);
    return app;
  }

  function buildEnv(): Env {
    return {
      ...baseEnv,
      DATABASE_URL,
      REGISTERED_CHANNELS_JSON,
      ENVIRONMENT: 'test',
    } as unknown as Env;
  }

  it('creates an intent with derived Roux from classification (Apps-Script shape)', async () => {
    const app = buildApp();
    const body = await buildAuthedBody({
      messageId: `${TEST_TAG}-msg-a`,
      classification: 'public',
      disputeType: 'public',
    });
    const res = await app.fetch(
      new Request('http://test/workspace/studio/roux-ingest/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      buildEnv(),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string; outputs: Record<string, unknown> };
    expect(json.status).toBe('SUCCESS');
    expect(json.outputs.privilege).toBe('public');
    expect(json.outputs.space).toBe('business');
    expect(json.outputs.gate_outcome).toBe('mirrored');
    expect(typeof json.outputs.intent_id).toBe('string');

    const sql = neon(DATABASE_URL!);
    const rows = await sql`SELECT privilege, space FROM cc_intents WHERE id = ${json.outputs.intent_id as string}`;
    expect(rows[0]?.privilege).toBe('public');
    expect(rows[0]?.space).toBe('business');
  });

  it('is idempotent by Gmail message_id (second call returns same intent_id)', async () => {
    const app = buildApp();
    const messageId = `${TEST_TAG}-msg-idem`;
    const first = await app.fetch(
      new Request('http://test/workspace/studio/roux-ingest/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(await buildAuthedBody({ messageId })),
      }),
      buildEnv(),
    );
    const firstJson = (await first.json()) as { outputs: { intent_id: string; idempotent_hit: boolean } };
    expect(firstJson.outputs.idempotent_hit).toBe(false);

    const second = await app.fetch(
      new Request('http://test/workspace/studio/roux-ingest/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(await buildAuthedBody({ messageId })),
      }),
      buildEnv(),
    );
    const secondJson = (await second.json()) as { outputs: { intent_id: string; idempotent_hit: boolean } };
    expect(secondJson.outputs.idempotent_hit).toBe(true);
    expect(secondJson.outputs.intent_id).toBe(firstJson.outputs.intent_id);
  });

  it('suppresses Notion mirror when classification is privileged/legal', async () => {
    const app = buildApp();
    const body = await buildAuthedBody({
      messageId: `${TEST_TAG}-msg-legal`,
      classification: 'legal',
      disputeType: 'legal',
    });
    const res = await app.fetch(
      new Request('http://test/workspace/studio/roux-ingest/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      buildEnv(),
    );
    const json = (await res.json()) as { outputs: { privilege: string; space: string; gate_outcome: string } };
    expect(json.outputs.privilege).toBe('privileged');
    expect(json.outputs.space).toBe('legalink');
    expect(json.outputs.gate_outcome).toBe('suppressed');
  });

  it('accepts the flat input shape too (defensive parsing)', async () => {
    const app = buildApp();
    const body = await buildAuthedBody({
      messageId: `${TEST_TAG}-msg-flat`,
      flatShape: true,
    });
    const res = await app.fetch(
      new Request('http://test/workspace/studio/roux-ingest/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      buildEnv(),
    );
    const json = (await res.json()) as { status: string; outputs: { intent_id: string } };
    expect(json.status).toBe('SUCCESS');
    expect(typeof json.outputs.intent_id).toBe('string');
  });

  it('rejects request when channel is not in REGISTERED_CHANNELS_JSON', async () => {
    const app = buildApp();
    const body = await buildAuthedBody({ messageId: `${TEST_TAG}-msg-bad-ch` });
    body.channel_id = 'chitty:channel:unknown';
    const res = await app.fetch(
      new Request('http://test/workspace/studio/roux-ingest/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      buildEnv(),
    );
    expect(res.status).toBe(403);
  });
});
