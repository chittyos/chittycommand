import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/index';
import type { Goal, Plan, Intent } from '../../meta/intent';
import { ingestContextual, type ContextualCandidate, type ClassificationResult } from '../../src/lib/contextual-ingest';

const env = {} as Env;

function makeCandidate(overrides: Partial<ContextualCandidate> = {}): ContextualCandidate {
  return {
    message_id: 101,
    source: 'contextual-mail',
    sent_at: '2026-06-28T00:00:00.000Z',
    body_text: 'Utility bill due soon',
    amount: 125.5,
    amount_raw: '125.50',
    payee: 'ComEd',
    due_date: '2026-07-05',
    has_legal_doc: false,
    extraction_confidence: 0.92,
    ...overrides,
  };
}

function makeClassifier(overrides: Partial<ClassificationResult> = {}): ClassificationResult {
  return {
    category: 'billing',
    confidence: 0.88,
    urgency: 'high',
    is_legal: false,
    reasoning: 'classified for test',
    via: 'deterministic_fallback',
    ...overrides,
  };
}

describe('ingestContextual orchestration', () => {
  it('short-circuits duplicate contextual messages before goal/plan creation', async () => {
    const fetchContextualCandidates = vi.fn(async () => [makeCandidate({ message_id: 42 })]);
    const classifyCandidate = vi.fn(async () => makeClassifier());
    const createGoal = vi.fn(async () => {
      throw new Error('goal creation should not run for duplicates');
    });
    const createPlan = vi.fn(async () => {
      throw new Error('plan creation should not run for duplicates');
    });
    const createContextualIngestIntentIdempotent = vi.fn(async () => ({
      intent: { id: 'intent-1' } as Intent,
      created: true,
    }));
    const tasksClient = vi.fn();
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join(' ${}');
      if (query.includes('FROM cc_intents') && query.includes("intent_type = 'contextual_ingest'")) {
        return [{ id: 'existing-intent' }];
      }
      throw new Error(`unexpected query in duplicate test: ${query} :: ${JSON.stringify(values)}`);
    });

    const result = await ingestContextual(
      env,
      sql as unknown as Parameters<typeof ingestContextual>[1],
      { limit: 10 },
      {
        fetchContextualCandidates,
        classifyCandidate,
        createGoal,
        createPlan,
        createContextualIngestIntentIdempotent,
        tasksClient,
        getContextualDb: () => ({}) as never,
      },
    );

    expect(result).toMatchObject({
      candidates_scanned: 1,
      skipped_duplicate: 1,
      intents_created: 0,
      obligations_created: 0,
      recommendations_created: 0,
      conflicts_raised: 0,
    });
    expect(fetchContextualCandidates).toHaveBeenCalledTimes(1);
    expect(classifyCandidate).not.toHaveBeenCalled();
    expect(createGoal).not.toHaveBeenCalled();
    expect(createPlan).not.toHaveBeenCalled();
    expect(createContextualIngestIntentIdempotent).not.toHaveBeenCalled();
    expect(tasksClient).not.toHaveBeenCalled();
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it('raises a reconciliation task when the inferred amount conflicts with an existing obligation', async () => {
    const candidate = makeCandidate({ message_id: 77, amount: 250, amount_raw: '250.00', payee: 'ComEd' });
    const fetchContextualCandidates = vi.fn(async () => [candidate]);
    const classifyCandidate = vi.fn(async () => makeClassifier({ urgency: 'critical', is_legal: true, via: 'inline_ai' }));
    const createGoal = vi.fn(async () => ({ id: 'goal-1' } as Goal));
    const createPlan = vi.fn(async () => ({ id: 'plan-1' } as Plan));
    const createContextualIngestIntentIdempotent = vi.fn(async () => ({
      intent: { id: 'intent-1' } as Intent,
      created: true,
    }));
    const createTask = vi.fn(async () => ({ id: 'task-1' }));
    const tasksClient = vi.fn(() => ({ createTask }));
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join(' ${}');
      if (query.includes('FROM cc_intents') && query.includes("intent_type = 'contextual_ingest'")) {
        return [];
      }
      if (query.includes('FROM cc_obligations') && query.includes('SELECT id, amount_due, source, source_ref, status')) {
        return [{ id: 'ob-1', amount_due: '100.00', source: 'manual', source_ref: 'manual-1', status: 'pending' }];
      }
      if (query.includes('INSERT INTO cc_obligations')) {
        return [{ id: 'ob-2' }];
      }
      if (query.includes('INSERT INTO cc_recommendations')) {
        return [{ id: 'rec-1' }];
      }
      throw new Error(`unexpected query in conflict test: ${query} :: ${JSON.stringify(values)}`);
    });

    const result = await ingestContextual(
      env,
      sql as unknown as Parameters<typeof ingestContextual>[1],
      { limit: 10 },
      {
        fetchContextualCandidates,
        classifyCandidate,
        createGoal,
        createPlan,
        createContextualIngestIntentIdempotent,
        tasksClient,
        getContextualDb: () => ({}) as never,
        now: () => new Date('2026-06-28T00:00:00.000Z'),
      },
    );

    expect(result).toMatchObject({
      candidates_scanned: 1,
      skipped_duplicate: 0,
      intents_created: 1,
      obligations_created: 1,
      recommendations_created: 1,
      conflicts_raised: 1,
      legalink_gated: 1,
    });
    expect(fetchContextualCandidates).toHaveBeenCalledTimes(1);
    expect(classifyCandidate).toHaveBeenCalledTimes(1);
    expect(createGoal).toHaveBeenCalledTimes(1);
    expect(createPlan).toHaveBeenCalledTimes(1);
    expect(createContextualIngestIntentIdempotent).toHaveBeenCalledTimes(1);
    expect(tasksClient).toHaveBeenCalledTimes(1);
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(sql).toHaveBeenCalledTimes(4);
  });
});
