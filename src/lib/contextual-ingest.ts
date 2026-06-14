/**
 * contextual-ingest.ts
 *
 * ChittyTriage intake spine arm W4c: digested cross-channel comms
 * (the "contextual" store) → classify via chittyrouter → chittycommand's
 * sovereign cc_ tables.
 *
 * Pipeline per candidate message:
 *   1. Pull digested signal from the contextual store (a SEPARATE Neon project,
 *      ChittyLedger-Messaging / delicate-moon — read-only). Candidates are
 *      messages carrying an `amount` entity plus a payee-like entity
 *      (person/org). `date` entities give a due date; `legal_document` and
 *      case-ref entities (#287 / #239 / 2024D007847) drive sensitivity.
 *   2. Route/classify via chittyrouter. We attempt its intelligentRoute surface
 *      (POST /process); the deployed edge currently does not expose it
 *      (404) and /agents/triage/classify returns a deterministic stub, so we
 *      fall back to the SAME model chittyrouter runs
 *      (@cf/meta/llama-3.1-8b-instruct-fast) inline via env.AI. This is
 *      AI-only inference — hence everything lands as `status='candidate'`.
 *   3. Write a cc_intents row (intent_type='contextual_ingest', idempotent on
 *      the contextual message id) — the durable intake artifact. NOTE:
 *      cc_intents.status stays on the executor enum ('pending'); the
 *      candidate→verified lifecycle lives on cc_obligations / cc_recommendations.
 *   4. Write an inferred cc_obligation (status='candidate', source='contextual',
 *      source_ref, confidence, sensitivity) — deduped on source_ref.
 *   5. CONFLICT: if an existing obligation for the same payee has a materially
 *      different amount, DO NOT overwrite — raise a chittyagent-tasks item
 *      (assigned chittyagent-command). Conflicts never auto-resolve (spine rule).
 *   6. cc_recommendations carry the same provenance so triage output is
 *      traceable back to the originating message.
 *
 * Sovereignty / Two-Space: every inferred row is AI-derived → `candidate`,
 * never `verified`. Legal / privileged-tagged signal → sensitivity='legalink'
 * + intent privilege so it does not bleed to Business surfaces.
 *
 * @canon: chittycanon://gov/governance#classification-axes  STATUS:PENDING
 * @canon: chittycanon://core/services/chittycommand/contextual-ingest
 */

import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import type { Env } from '../index';
import { typedRows } from './db';
import { createGoal, createPlan, createContextualIngestIntentIdempotent } from '../../meta/intent';
import { tasksClient } from './integrations';

// Llama model chittyrouter's intelligentRoute runs (from its /health report).
const ROUTER_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';

// Case refs / patterns that force legalink sensitivity + privileged intent.
// @canon: chittyview-projection-spine — divorce 2024D007847 work product is
// privileged even though it is business-relevant.
const LEGAL_CASE_PATTERN = /2024D007847|#?\s?287\b|#?\s?239\b|arias\s+v\.?\s+bianchi/i;
const LEGAL_KEYWORD_PATTERN = /\b(lawsuit|subpoena|court|hearing|motion|deposition|notice of motion|debt[-\s]?collection|collection agency)\b/i;

export interface ContextualCandidate {
  message_id: number;
  source: string;
  sent_at: string;
  body_text: string;
  amount: number;
  amount_raw: string;
  payee: string | null;
  due_date: string | null;
  has_legal_doc: boolean;
  extraction_confidence: number;
}

export interface ClassificationResult {
  category: string;
  confidence: number; // 0..1
  urgency: 'low' | 'normal' | 'high' | 'critical';
  is_legal: boolean;
  reasoning: string;
  via: 'router_process' | 'inline_ai' | 'deterministic_fallback';
}

export interface ContextualIngestResult {
  candidates_scanned: number;
  intents_created: number;
  obligations_created: number;
  recommendations_created: number;
  conflicts_raised: number;
  skipped_duplicate: number;
  legalink_gated: number;
  classifier_via: Record<string, number>;
}

// ── Contextual read connection ──────────────────────────────────
// The contextual store is a different Neon project than the command DB.
function getContextualDb(env: Env): NeonQueryFunction<false, false> | null {
  const conn = env.CONTEXTUAL_DATABASE_URL;
  if (!conn) return null;
  return neon(conn);
}

/**
 * Pull candidate obligation signals from the contextual store.
 * A candidate = a message with an `amount` entity. We co-resolve the strongest
 * payee (person/org), the nearest `date`, and whether any legal_document /
 * case-ref entity co-occurs (sensitivity driver).
 */
export async function fetchContextualCandidates(
  ctxSql: NeonQueryFunction<false, false>,
  limit: number,
): Promise<ContextualCandidate[]> {
  // ONE candidate per message (the obligation primitive is the message, not
  // each amount mention). A message can mention several amounts
  // ($1,000 / $2,845 / $3,845) — we deterministically take the MAX amount as
  // the headline obligation (largest = most material; deterministic so the
  // dedup'd obligation is reproducible regardless of row order). DISTINCT ON
  // (message_id) ordered by amount DESC.
  const rows = await ctxSql`
    SELECT DISTINCT ON (m.message_id)
      m.message_id,
      m.source::text                                   AS source,
      m.sent_at                                         AS sent_at,
      COALESCE(m.body_text, '')                         AS body_text,
      ea.normalized_value                               AS amount_norm,
      ea.value                                          AS amount_raw,
      xa.confidence                                     AS extraction_confidence,
      -- strongest co-occurring payee (org preferred over person)
      (SELECT e2.value FROM contextual.entity_extractions x2
         JOIN contextual.entities e2 ON e2.entity_id = x2.entity_id
        WHERE x2.message_id = m.message_id AND e2.type IN ('org','organization','person')
        ORDER BY (e2.type IN ('org','organization')) DESC, x2.confidence DESC NULLS LAST
        LIMIT 1)                                        AS payee,
      -- nearest date entity (due date hint)
      (SELECT e3.normalized_value FROM contextual.entity_extractions x3
         JOIN contextual.entities e3 ON e3.entity_id = x3.entity_id
        WHERE x3.message_id = m.message_id AND e3.type = 'date'
        ORDER BY x3.confidence DESC NULLS LAST LIMIT 1)  AS due_date_norm,
      -- legal sensitivity driver
      EXISTS (SELECT 1 FROM contextual.entity_extractions x4
         JOIN contextual.entities e4 ON e4.entity_id = x4.entity_id
        WHERE x4.message_id = m.message_id AND e4.type IN ('legal_document'))
                                                         AS has_legal_doc
    FROM contextual.entity_extractions xa
    JOIN contextual.entities ea ON ea.entity_id = xa.entity_id
    JOIN contextual.messages m  ON m.message_id  = xa.message_id
    WHERE ea.type = 'amount'
      AND ea.normalized_value ~ '^[0-9]+(\\.[0-9]+)?$'
      AND (ea.normalized_value)::numeric >= 100
      AND m.deleted_at IS NULL
    -- DISTINCT ON requires the distinct key to lead ORDER BY; pick MAX amount
    -- per message. Outer query re-orders the collapsed set by recency + caps it.
    ORDER BY m.message_id, (ea.normalized_value)::numeric DESC
  `;
  // Re-order by recency and cap (the DISTINCT ON forced message_id-led order).
  const candidatesRaw = [...(rows as Record<string, unknown>[])]
    .sort((a, b) => new Date(String(b.sent_at)).getTime() - new Date(String(a.sent_at)).getTime())
    .slice(0, limit);

  return typedRows<{
    message_id: number;
    source: string;
    sent_at: string;
    body_text: string;
    amount_norm: string;
    amount_raw: string;
    extraction_confidence: number | null;
    payee: string | null;
    due_date_norm: string | null;
    has_legal_doc: boolean;
  }>(candidatesRaw).map((r) => ({
    message_id: Number(r.message_id),
    source: r.source,
    sent_at: r.sent_at,
    body_text: r.body_text,
    amount: parseFloat(r.amount_norm),
    amount_raw: r.amount_raw,
    payee: r.payee,
    due_date: normalizeDueDate(r.due_date_norm),
    has_legal_doc: !!r.has_legal_doc,
    extraction_confidence: r.extraction_confidence != null ? Number(r.extraction_confidence) : 0.5,
  }));
}

/** Best-effort ISO date from a contextual `date` normalized_value. */
function normalizeDueDate(v: string | null): string | null {
  if (!v) return null;
  const d = new Date(v);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

/**
 * Classify a candidate. Attempt chittyrouter intelligentRoute (POST /process);
 * on any non-2xx / unusable shape, fall back to the same model inline via
 * env.AI; if AI is unavailable, a deterministic feature-based fallback.
 * All paths are AI/inference → caller writes status='candidate'.
 */
export async function classifyCandidate(
  env: Env,
  cand: ContextualCandidate,
): Promise<ClassificationResult> {
  const text = `${cand.body_text}`.slice(0, 1500);
  const legalSignal =
    cand.has_legal_doc || LEGAL_CASE_PATTERN.test(text) || LEGAL_KEYWORD_PATTERN.test(text);

  // 1) chittyrouter intelligentRoute (POST /process). Returns ai.analysis with
  //    category/priority/urgency_score when available.
  if (env.CHITTYROUTER_URL) {
    try {
      const res = await fetch(`${env.CHITTYROUTER_URL}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Source-Service': 'chittycommand' },
        body: JSON.stringify({
          from: cand.payee ?? 'unknown',
          to: 'nick@nevershitty.com',
          subject: (cand.body_text || '').slice(0, 120),
          content: text,
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) {
        const j = (await res.json()) as {
          ai?: { analysis?: { category?: string; urgency_score?: number; priority?: string; case_related?: boolean; reasoning?: string } };
        };
        const a = j.ai?.analysis;
        if (a && a.category) {
          return {
            category: a.category,
            confidence: clamp01(a.urgency_score ?? 0.6),
            urgency: mapPriority(a.priority),
            is_legal: legalSignal || !!a.case_related || /legal|court|lawsuit|compliance/i.test(a.category),
            reasoning: a.reasoning ?? 'chittyrouter intelligentRoute',
            via: 'router_process',
          };
        }
      }
    } catch (err) {
      console.warn('[contextual-ingest] router /process unavailable, falling back to inline AI:', err);
    }
  }

  // 2) Inline AI with the SAME model chittyrouter runs.
  if (env.AI) {
    try {
      const prompt =
        `You are ChittyRouter AI classifying a financial/legal comms message into a triage signal.\n` +
        `Message: """${text}"""\n` +
        `Detected payee: ${cand.payee ?? 'unknown'}; amount: ${cand.amount_raw}.\n` +
        `Respond ONLY with compact JSON: {"category":"billing|debt_collection|legal|lease|inquiry|other",` +
        `"confidence":0.0-1.0,"urgency":"low|normal|high|critical","is_legal":true|false,"reasoning":"short"}`;
      // ROUTER_MODEL is a valid Workers AI model id but may not be in the
      // pinned AiModels union — cast the model id, not the binding.
      const out = (await env.AI.run(ROUTER_MODEL as keyof AiModels, {
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200,
      } as never)) as { response?: string };
      const parsed = extractJson(out?.response ?? '');
      if (parsed) {
        return {
          category: String(parsed.category ?? 'other'),
          confidence: clamp01(Number(parsed.confidence ?? 0.6)),
          urgency: normalizeUrgency(parsed.urgency),
          is_legal: legalSignal || parsed.is_legal === true,
          reasoning: String(parsed.reasoning ?? 'inline llama classification'),
          via: 'inline_ai',
        };
      }
    } catch (err) {
      console.warn('[contextual-ingest] inline AI classify failed, using deterministic fallback:', err);
    }
  }

  // 3) Deterministic feature fallback — real signal, not a mock: extraction
  //    confidence scaled down (inference-only), category from legal/keyword.
  return {
    category: legalSignal ? 'legal' : LEGAL_KEYWORD_PATTERN.test(text) ? 'debt_collection' : 'billing',
    confidence: clamp01(cand.extraction_confidence * 0.7),
    urgency: legalSignal ? 'high' : 'normal',
    is_legal: legalSignal,
    reasoning: 'deterministic fallback (router + AI unavailable); features: amount+payee entity, legal pattern match',
    via: 'deterministic_fallback',
  };
}

/**
 * Run the full contextual → triage ingest over a batch.
 */
export async function ingestContextual(
  env: Env,
  sql: NeonQueryFunction<false, false>,
  opts: { limit?: number; ownerChittyId?: string } = {},
): Promise<ContextualIngestResult> {
  const limit = opts.limit ?? 50;
  const owner = opts.ownerChittyId ?? 'nick@nevershitty.com';

  const result: ContextualIngestResult = {
    candidates_scanned: 0,
    intents_created: 0,
    obligations_created: 0,
    recommendations_created: 0,
    conflicts_raised: 0,
    skipped_duplicate: 0,
    legalink_gated: 0,
    classifier_via: {},
  };

  const ctxSql = getContextualDb(env);
  if (!ctxSql) {
    throw new Error('[contextual-ingest] CONTEXTUAL_DATABASE_URL not set — cannot read the contextual store');
  }

  const candidates = await fetchContextualCandidates(ctxSql, limit);
  result.candidates_scanned = candidates.length;

  for (const cand of candidates) {
    const sourceRef = `ctx-msg-${cand.message_id}`;
    try {
      const cls = await classifyCandidate(env, cand);
      result.classifier_via[cls.via] = (result.classifier_via[cls.via] ?? 0) + 1;

      // Per-edge Two-Space gate. legalink => privileged.
      const sensitivity: 'business' | 'legalink' = cls.is_legal ? 'legalink' : 'business';
      const privilege = cls.is_legal ? 'privileged' : 'public';
      const space = sensitivity;
      if (sensitivity === 'legalink') result.legalink_gated++;

      // ── 1. cc_intents (durable intake artifact, idempotent) ──
      // status stays on the executor enum ('pending'); provenance in payload.
      let intentCreated = false;
      try {
        const goal = await createGoal(env, {
          ownerChittyId: owner,
          title: `contextual_ingest: ${cand.payee ?? sourceRef}`,
          description: `Digested ${cand.source} signal — ${cand.amount_raw}`,
          priority: cls.urgency === 'critical' ? 1 : cls.urgency === 'high' ? 2 : 5,
          metadata: { source: 'contextual', source_ref: sourceRef },
        });
        const plan = await createPlan(env, {
          goalId: goal.id,
          title: `Ingest contextual message ${cand.message_id}`,
          authoredBy: 'contextual-ingest',
        });
        const { created } = await createContextualIngestIntentIdempotent(env, {
          planId: plan.id,
          goalId: goal.id,
          intentType: 'contextual_ingest',
          targetChannel: cand.source,
          privilege,
          space,
          messageId: sourceRef,
          payload: {
            source: {
              channel: 'contextual',
              message_id: sourceRef,
              contextual_message_id: cand.message_id,
              origin_channel: cand.source,
              sent_at: cand.sent_at,
            },
            classification: cls.category,
            classifier_via: cls.via,
            confidence: cls.confidence,
            amount: cand.amount,
            payee: cand.payee,
            due_date: cand.due_date,
            sensitivity,
            status: 'candidate', // lifecycle marker carried in payload, not in status column
            reasoning: cls.reasoning,
          },
          metadata: { source: 'contextual', source_ref: sourceRef },
        });
        intentCreated = created;
        if (created) result.intents_created++;
      } catch (err) {
        console.error(`[contextual-ingest] intent create failed for ${sourceRef}:`, err);
      }

      // Only fan out obligation/recommendation on a freshly created intent —
      // idempotent re-runs skip the rest.
      if (!intentCreated) {
        result.skipped_duplicate++;
        continue;
      }

      if (!cand.payee) {
        // No payee → cannot form a meaningful obligation; intent stands as the record.
        continue;
      }

      // ── 2. Conflict check vs existing obligations for this payee ──
      // Existing record with a materially different amount => raise a task,
      // never overwrite. (Existing == any non-candidate or different-source row.)
      const existing = typedRows<{ id: string; amount_due: string | null; source: string | null; source_ref: string | null; status: string }>(
        await sql`
          SELECT id, amount_due, source, source_ref, status
          FROM cc_obligations
          WHERE lower(payee) = lower(${cand.payee})
          ORDER BY created_at DESC
          LIMIT 1
        `,
      );
      const conflict =
        existing[0] &&
        existing[0].source_ref !== sourceRef &&
        existing[0].amount_due != null &&
        Math.abs(parseFloat(existing[0].amount_due) - cand.amount) > 1 &&
        existing[0].source !== 'contextual';

      if (conflict) {
        const tasks = tasksClient(env);
        const task = tasks
          ? await tasks.createTask({
              title: `Reconcile obligation conflict: ${cand.payee}`,
              description:
                `Contextual signal (${sourceRef}) infers $${cand.amount} for ${cand.payee}, ` +
                `but existing obligation ${existing[0].id} (source=${existing[0].source ?? 'manual'}) ` +
                `has $${existing[0].amount_due}. Values disagree — manual reconcile required.`,
              task_type: 'reconciliation',
              assigned_agent: 'chittyagent-command',
              priority: 2,
              // @canon: agent_tasks.tasks urgency enum (now|today|this_week|later)
              urgency: cls.is_legal ? 'today' : 'this_week',
              needs_nick: cls.is_legal,
              payload: {
                kind: 'obligation_amount_conflict',
                source_ref: sourceRef,
                payee: cand.payee,
                inferred_amount: cand.amount,
                existing_obligation_id: existing[0].id,
                existing_amount: existing[0].amount_due,
                sensitivity,
              },
            })
          : null;
        if (task) {
          result.conflicts_raised++;
        } else {
          console.warn(`[contextual-ingest] conflict for ${cand.payee} but task creation failed`);
        }
        // We do NOT overwrite the existing record — that is what the conflict
        // task owns. But we STILL persist the new inferred row as a clearly
        // marked `candidate` (full provenance), so the disagreeing value is
        // visible for reconciliation rather than silently dropped. The two
        // rows (existing + candidate) coexist until a human/non-AI source
        // resolves the conflict task.
      }

      // ── 3. Inferred cc_obligation (candidate, full provenance, deduped) ──
      const dueDate = cand.due_date ?? new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
      const category = cls.is_legal ? 'legal' : cls.category === 'lease' ? 'rent' : 'other';
      const inserted = await sql`
        INSERT INTO cc_obligations
          (category, payee, amount_due, due_date, status, source, source_ref, confidence, sensitivity, metadata)
        VALUES
          (${category}, ${cand.payee}, ${cand.amount}, ${dueDate}, 'candidate',
           'contextual', ${sourceRef}, ${cls.confidence}, ${sensitivity},
           ${JSON.stringify({
             origin_channel: cand.source,
             classifier_via: cls.via,
             classification: cls.category,
             reasoning: cls.reasoning,
             contextual_message_id: cand.message_id,
           })}::jsonb)
        ON CONFLICT (source_ref) WHERE source = 'contextual' AND source_ref IS NOT NULL
        DO NOTHING
        RETURNING id
      `;
      if (inserted[0]) {
        result.obligations_created++;
        const obligationId = (inserted[0] as { id: string }).id;

        // ── 4. cc_recommendation tied to the inferred obligation ──
        await sql`
          INSERT INTO cc_recommendations
            (obligation_id, rec_type, priority, title, reasoning, action_type,
             model_version, confidence, suggested_amount, status, source, source_ref, sensitivity)
          VALUES
            (${obligationId}, ${cls.is_legal ? 'legal' : 'payment'},
             ${cls.urgency === 'critical' ? 1 : cls.urgency === 'high' ? 2 : 4},
             ${`Review inferred obligation: ${cand.payee} ($${cand.amount})`},
             ${`Inferred from ${cand.source} message ${sourceRef} (confidence ${(cls.confidence * 100).toFixed(0)}%, via ${cls.via}). ` +
               `Candidate — verify against a non-AI source before acting.`},
             'review_candidate', ${`contextual-ingest/${cls.via}`}, ${cls.confidence},
             ${cand.amount}, 'active', 'contextual', ${sourceRef}, ${sensitivity})
        `;
        result.recommendations_created++;
      } else {
        result.skipped_duplicate++;
      }
    } catch (err) {
      console.error(`[contextual-ingest] candidate ${sourceRef} failed:`, err);
    }
  }

  return result;
}

// ── small helpers ────────────────────────────────────────────
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}
function mapPriority(p?: string): 'low' | 'normal' | 'high' | 'critical' {
  switch ((p ?? '').toUpperCase()) {
    case 'CRITICAL': return 'critical';
    case 'HIGH': return 'high';
    case 'LOW': return 'low';
    default: return 'normal';
  }
}
function normalizeUrgency(u: unknown): 'low' | 'normal' | 'high' | 'critical' {
  const s = String(u ?? '').toLowerCase();
  return s === 'low' || s === 'high' || s === 'critical' ? s : 'normal';
}
function extractJson(s: string): Record<string, unknown> | null {
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]) as Record<string, unknown>; } catch { return null; }
}
