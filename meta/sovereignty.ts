/**
 * Meta-orchestrator — Sovereignty gate.
 *
 * Decides whether the meta-orchestrator may act autonomously on behalf of an
 * actor for a given intent, based on the actor's live ChittyTrust score.
 *
 * Calls https://trust.chitty.cc/v1/reckon/:chittyId (cached GET).
 *
 * Binding rule: no mock scores. If ChittyTrust is unreachable or returns
 * an unparsable response, the gate returns 'blocked' with the underlying
 * error so the caller (a) never silently acts autonomously, and (b) surfaces
 * the integration failure.
 *
 * @canonical-uri chittycanon://docs/architecture/chittycommand/ADR-001
 */

export interface SovereigntyEnv {
  CHITTYTRUST_URL?: string;
  /** Optional bearer token if the ChittyTrust deployment requires auth. */
  CHITTYTRUST_TOKEN?: string;
}

export interface IntentForSovereignty {
  intentType: string;
  /**
   * Free-form "sensitivity" the caller has already determined. The gate uses
   * this together with the trust score to make the autonomous/human/blocked
   * decision. Optional — defaults to 'normal'.
   */
  sensitivity?: 'low' | 'normal' | 'sensitive' | 'critical';
  /**
   * @canon: chittycanon://gov/governance#classification-axes  STATUS:PENDING
   *
   * ChittyRoux privilege class — orthogonal to `sensitivity` (which is the
   * trust-tier axis the decide() matrix consumes). `privilege` is informational
   * here so callers can persist it on the intent; it does NOT feed decide().
   *
   * - privileged       — attorney-client / work-product
   * - pii              — personally identifiable info
   * - hoa_evidentiary  — HOA-relevant evidentiary material
   * - public           — no privilege class applies
   */
  privilege?: 'privileged' | 'pii' | 'hoa_evidentiary' | 'public';
  /** Optional human-readable summary for audit trail. */
  summary?: string;
}

export type SovereigntyDecision = 'autonomous' | 'requires_human' | 'blocked';

export interface SovereigntyResult {
  decision: SovereigntyDecision;
  reasoning: string;
  trustScore: number;
  /** Raw response from ChittyTrust for audit, if available. */
  raw?: unknown;
}

const DEFAULT_TRUST_URL = 'https://trust.chitty.cc';

/**
 * Decision matrix (foundation PR — interface only, no semantics beyond this):
 *
 *   sensitivity \ trust    | <0.30     | 0.30–0.69        | >=0.70
 *   ───────────────────────┼───────────┼──────────────────┼─────────────
 *   low                    | requires_ | autonomous       | autonomous
 *                          | human     |                  |
 *   normal                 | blocked   | requires_human   | autonomous
 *   sensitive              | blocked   | requires_human   | requires_human
 *   critical               | blocked   | blocked          | requires_human
 *
 * The thresholds are intentionally conservative. The autonomous-loop policy
 * semantics live in a follow-up PR (per ADR-001 out-of-scope list).
 */
export async function assessSovereignty(
  actorChittyId: string,
  intent: IntentForSovereignty,
  env: SovereigntyEnv,
): Promise<SovereigntyResult> {
  if (!actorChittyId || actorChittyId.trim().length === 0) {
    return {
      decision: 'blocked',
      reasoning: 'Empty actorChittyId — cannot assess sovereignty without an identity',
      trustScore: 0,
    };
  }

  const base = (env.CHITTYTRUST_URL ?? DEFAULT_TRUST_URL).replace(/\/$/, '');
  const url = `${base}/v1/reckon/${encodeURIComponent(actorChittyId)}`;

  let raw: unknown;
  let trustScore: number;
  try {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-ChittyOS-Caller': 'chittycommand-meta-orchestrator',
    };
    if (env.CHITTYTRUST_TOKEN) {
      headers.Authorization = `Bearer ${env.CHITTYTRUST_TOKEN}`;
    }
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        decision: 'blocked',
        reasoning: `ChittyTrust returned HTTP ${res.status}: ${body.slice(0, 200)}`,
        trustScore: 0,
      };
    }
    raw = await res.json();
    trustScore = extractTrustScore(raw);
  } catch (err) {
    return {
      decision: 'blocked',
      reasoning: `ChittyTrust unreachable: ${err instanceof Error ? err.message : String(err)}`,
      trustScore: 0,
    };
  }

  const sensitivity = intent.sensitivity ?? 'normal';
  const decision = decide(trustScore, sensitivity);
  const reasoning =
    `actor=${actorChittyId} intent_type=${intent.intentType} ` +
    `sensitivity=${sensitivity} trust=${trustScore.toFixed(2)} → ${decision}`;

  return { decision, reasoning, trustScore, raw };
}

function decide(trustScore: number, sensitivity: NonNullable<IntentForSovereignty['sensitivity']>): SovereigntyDecision {
  if (Number.isNaN(trustScore)) return 'blocked';

  if (sensitivity === 'low') {
    if (trustScore < 0.3) return 'requires_human';
    return 'autonomous';
  }
  if (sensitivity === 'normal') {
    if (trustScore < 0.3) return 'blocked';
    if (trustScore < 0.7) return 'requires_human';
    return 'autonomous';
  }
  if (sensitivity === 'sensitive') {
    if (trustScore < 0.3) return 'blocked';
    return 'requires_human';
  }
  // critical
  if (trustScore < 0.7) return 'blocked';
  return 'requires_human';
}

/**
 * ChittyTrust's reckon endpoint returns a DRL trust report. The exact shape is
 * versioned; we accept a few documented shapes and fall back to NaN (which the
 * decide() function maps to 'blocked') if no score field is found.
 */
function extractTrustScore(raw: unknown): number {
  if (!raw || typeof raw !== 'object') return NaN;
  const obj = raw as Record<string, unknown>;
  const candidates: Array<unknown> = [
    obj.trustScore,
    obj.trust_score,
    obj.score,
    (obj.reckoning as Record<string, unknown> | undefined)?.score,
    (obj.focal as Record<string, unknown> | undefined)?.score,
  ];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) {
      // Normalize 0-100 to 0-1 if it looks like a percentage
      return c > 1 ? c / 100 : c;
    }
  }
  return NaN;
}
