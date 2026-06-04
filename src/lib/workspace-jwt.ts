/**
 * Google Workspace Add-on (HTTP mode) ID token verification.
 *
 * Google sends two ID tokens in the `authorizationEventObject` payload of every
 * Workspace Studio custom-step invocation:
 *
 *   - `systemIdToken` — signed assertion that THIS request originated from
 *     Google's Apps Script / Workspace Add-on infrastructure. The `email`
 *     claim is the marketplace service account, the `aud` claim is the
 *     OAuth client ID configured for the add-on.
 *   - `userIdToken`   — signed assertion identifying the END-USER acting in
 *     Workspace. Same audience pinning as `systemIdToken`.
 *
 * Both are RS256-signed by Google. Public keys live at the standard JWKS
 * endpoint `https://www.googleapis.com/oauth2/v3/certs`.
 *
 * Docs:
 *   https://developers.google.com/workspace/add-ons/concepts/http-overview#verifying_jwts
 *
 * Design notes:
 *   - The JWKS URL is injectable via `env.GCP_JWKS_URL` so tests can point at
 *     a local static-served JWKS without globally mocking fetch.
 *   - JWKS responses are cached in `COMMAND_KV` under `gcp:jwks` for 3600s
 *     (Google rotates these keys daily; we re-fetch on cache miss / expiry).
 *
 * @canon: chittycanon://core/services/chittycommand/workspace-studio
 */

import { jwtVerify, importJWK, type JWK } from 'jose';
import type { Env } from '../index';

const DEFAULT_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const JWKS_KV_KEY = 'gcp:jwks';
const JWKS_TTL_SECONDS = 3600;

const ALLOWED_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

export class WorkspaceJWTError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'WorkspaceJWTError';
  }
}

interface CachedJWKS {
  keys: JWK[];
  fetched_at: number;
}

interface WorkspaceEnv extends Pick<Env, 'COMMAND_KV'> {
  CHITTYROUX_GCP_SA_EMAIL?: string;
  CHITTYROUX_MARKETPLACE_OAUTH_CLIENT_ID?: string;
  GCP_JWKS_URL?: string;
}

async function getJWKS(env: WorkspaceEnv): Promise<JWK[]> {
  const url = env.GCP_JWKS_URL ?? DEFAULT_JWKS_URL;

  // KV cache first.
  try {
    const cached = await env.COMMAND_KV.get(JWKS_KV_KEY, { type: 'json' }) as CachedJWKS | null;
    if (cached && Array.isArray(cached.keys) && cached.keys.length > 0) {
      const age = Math.floor(Date.now() / 1000) - cached.fetched_at;
      if (age < JWKS_TTL_SECONDS) return cached.keys;
    }
  } catch {
    /* fall through to fetch */
  }

  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new WorkspaceJWTError(
      'JWKS_FETCH_FAILED',
      `Failed to fetch JWKS from ${url}: HTTP ${res.status}`,
    );
  }
  const body = await res.json() as { keys?: JWK[] };
  if (!body.keys || !Array.isArray(body.keys) || body.keys.length === 0) {
    throw new WorkspaceJWTError('JWKS_MALFORMED', 'JWKS response missing keys');
  }
  const payload: CachedJWKS = { keys: body.keys, fetched_at: Math.floor(Date.now() / 1000) };
  try {
    await env.COMMAND_KV.put(JWKS_KV_KEY, JSON.stringify(payload), { expirationTtl: JWKS_TTL_SECONDS });
  } catch {
    /* non-fatal — caching is opportunistic */
  }
  return body.keys;
}

async function verifyWithJWKS(
  token: string,
  jwks: JWK[],
  expectedAudience: string,
): Promise<Record<string, unknown>> {
  // jose has createRemoteJWKSet, but we cache through KV so we resolve the kid
  // manually and importJWK for the matching entry.
  const [headerB64] = token.split('.');
  if (!headerB64) {
    throw new WorkspaceJWTError('TOKEN_MALFORMED', 'JWT missing header segment');
  }
  let header: { kid?: string; alg?: string };
  try {
    const json = atob(headerB64.replace(/-/g, '+').replace(/_/g, '/'));
    header = JSON.parse(json);
  } catch {
    throw new WorkspaceJWTError('TOKEN_MALFORMED', 'JWT header is not valid JSON');
  }
  const match = jwks.find((k) => k.kid === header.kid) ?? jwks[0];
  if (!match) {
    throw new WorkspaceJWTError('JWKS_NO_MATCH', `No JWK matching kid=${header.kid}`);
  }
  const alg = header.alg || (match.alg as string) || 'RS256';
  const key = await importJWK(match, alg);
  try {
    const { payload } = await jwtVerify(token, key, {
      audience: expectedAudience,
      algorithms: [alg],
    });
    return payload as Record<string, unknown>;
  } catch (err) {
    throw new WorkspaceJWTError(
      'TOKEN_INVALID',
      `JWT verification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function requireIssuer(payload: Record<string, unknown>): void {
  const iss = payload.iss;
  if (typeof iss !== 'string' || !ALLOWED_ISSUERS.has(iss)) {
    throw new WorkspaceJWTError(
      'ISSUER_INVALID',
      `Issuer ${iss} is not a recognized Google issuer`,
    );
  }
}

export interface WorkspaceTokenClaims {
  sub: string;
  email: string;
  aud: string;
  iss: string;
}

/**
 * Verify Google's `systemIdToken`: per the Workspace HTTP add-on docs
 * (https://developers.google.com/workspace/add-ons/guides/alternate-runtimes#validate_requests),
 * the `aud` claim is the **full endpoint URL** Google invoked (not the OAuth
 * client ID — that audience is used only for `userIdToken`). The `email`
 * claim MUST match the configured marketplace service account.
 *
 * @param token       The systemIdToken from authorizationEventObject.
 * @param env         Worker env with COMMAND_KV + SA pinning config.
 * @param requestUrl  The canonical endpoint URL Google was configured to call
 *                    (i.e. `c.req.url` or a manifest-derived equivalent).
 */
export async function verifyWorkspaceSystemIdToken(
  token: string,
  env: WorkspaceEnv,
  requestUrl: string,
): Promise<WorkspaceTokenClaims> {
  const expectedSa = env.CHITTYROUX_GCP_SA_EMAIL;
  if (!expectedSa) throw new WorkspaceJWTError('CONFIG_MISSING', 'CHITTYROUX_GCP_SA_EMAIL not configured');
  if (!requestUrl) throw new WorkspaceJWTError('CONFIG_MISSING', 'requestUrl required for systemIdToken verification');

  const jwks = await getJWKS(env);
  const payload = await verifyWithJWKS(token, jwks, requestUrl);
  requireIssuer(payload);

  const email = typeof payload.email === 'string' ? payload.email : '';
  if (email !== expectedSa) {
    throw new WorkspaceJWTError(
      'SA_MISMATCH',
      `systemIdToken email ${email || '<missing>'} does not match expected SA`,
    );
  }
  return {
    sub: String(payload.sub ?? ''),
    email,
    aud: String(payload.aud ?? ''),
    iss: String(payload.iss ?? ''),
  };
}

/**
 * Verify Google's `userIdToken`: identifies the end-user. No SA pinning — the
 * email claim is the human user.
 */
export async function verifyWorkspaceUserIdToken(
  token: string,
  env: WorkspaceEnv,
): Promise<WorkspaceTokenClaims> {
  const expectedAud = env.CHITTYROUX_MARKETPLACE_OAUTH_CLIENT_ID;
  if (!expectedAud) throw new WorkspaceJWTError('CONFIG_MISSING', 'CHITTYROUX_MARKETPLACE_OAUTH_CLIENT_ID not configured');

  const jwks = await getJWKS(env);
  const payload = await verifyWithJWKS(token, jwks, expectedAud);
  requireIssuer(payload);

  const email = typeof payload.email === 'string' ? payload.email : '';
  if (!email) {
    throw new WorkspaceJWTError('USER_EMAIL_MISSING', 'userIdToken missing email claim');
  }
  return {
    sub: String(payload.sub ?? ''),
    email,
    aud: String(payload.aud ?? ''),
    iss: String(payload.iss ?? ''),
  };
}
