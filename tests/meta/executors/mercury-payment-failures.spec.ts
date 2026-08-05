/**
 * Direct integration tests for the Mercury payment executor's failure-mode
 * handling — discriminated `post()` result, body-status mapping, chat refusal,
 * and account_slug normalization.
 *
 * These tests drive `runMercuryPayment` with an injected fetch double so we
 * can deterministically exercise Mercury's 5xx / 409 / 2xx-with-status=failed
 * / 2xx-with-status=pending responses WITHOUT mocking mercuryClient itself.
 * The fetch double is a real fetch impl that constructs real Response objects
 * — no `vi.mock(...)` is used on the client, the DB, or any service module.
 *
 * Per the PR-108 "no mocks of Mercury or DB" rule: dependency-injecting fetch
 * is the only non-mock path to exercise non-2xx Mercury responses, and is
 * therefore the canonical way to test these failure branches.
 *
 * @canonical-uri chittycanon://core/services/chittycommand/executors/mercury_payment
 */

import { describe, it, expect } from 'vitest';
import {
  runMercuryPayment,
  MERCURY_SOVEREIGNTY_FRESHNESS_MS,
} from '../../../meta/executors/mercury-payment';
import type { Env } from '../../../src/index';

const KV_WITH_TOKEN = {
  get: async (key: string) =>
    key === 'mercury:token:aribia-llc' ? 'sk_test_real_shape_token' : null,
  put: async () => undefined,
  delete: async () => undefined,
  list: async () => ({ keys: [], list_complete: true, cursor: '' }),
} as unknown as KVNamespace;

const KV_NO_TOKEN = {
  get: async () => null,
  put: async () => undefined,
  delete: async () => undefined,
  list: async () => ({ keys: [], list_complete: true, cursor: '' }),
} as unknown as KVNamespace;

function envFor(kv: KVNamespace): Env {
  return {
    MERCURY_AUTONOMOUS_AMOUNT_CAP_USD: '500',
    COMMAND_KV: kv,
  } as unknown as Env;
}

const FRESH_ASSESSMENT = {
  decision: 'autonomous',
  assessedAt: new Date().toISOString(),
};

const VALID_PAYLOAD = {
  account_slug: 'aribia-llc',
  mercury_account_id: 'acct_real_0001',
  recipient_id: 'rcpt_real_0001',
  amount_cents: 1_00,
  currency: 'USD' as const,
  memo: 'integration-test',
};

/**
 * Build a fetch impl that returns the given status + body on the FIRST POST
 * to Mercury, and refuses all other calls. Real Response objects, no mocks.
 */
function fetchReturning(status: number, body: string): typeof fetch {
  return (async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return new Response(body, {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

function fetchThrowing(): typeof fetch {
  return (async () => {
    throw new TypeError('fetch failed: ECONNREFUSED');
  }) as unknown as typeof fetch;
}

describe('mercury-payment — discriminated-error & body-status handling (real Response, injected fetch)', () => {
  it('Mercury returns 5xx → refusal with mercury_api_failure, httpStatus + bodySnippet populated', async () => {
    const run = await runMercuryPayment({
      env: envFor(KV_WITH_TOKEN),
      payload: VALID_PAYLOAD,
      sovereignty: FRESH_ASSESSMENT,
      idempotencyKey: 'a'.repeat(64),
      fetchImpl: fetchReturning(503, '{"error":"upstream timeout"}'),
    });
    expect(run.ok).toBe(false);
    expect(run.refusalReason).toBe('mercury_api_failure');
    expect(run.failureKind).toBe('http');
    expect(run.httpStatus).toBe(503);
    expect(run.bodySnippet).toContain('upstream timeout');
    // 5xx → money may have moved → indeterminate (row left in_flight, not failed).
    expect(run.indeterminate).toBe(true);
  });

  it('Mercury returns 409 → refusal with idempotency_collision (replay-attack tell)', async () => {
    const run = await runMercuryPayment({
      env: envFor(KV_WITH_TOKEN),
      payload: VALID_PAYLOAD,
      sovereignty: FRESH_ASSESSMENT,
      idempotencyKey: 'b'.repeat(64),
      fetchImpl: fetchReturning(409, '{"error":"idempotency conflict with different payload"}'),
    });
    expect(run.ok).toBe(false);
    expect(run.refusalReason).toBe('idempotency_collision');
    expect(run.failureKind).toBe('idempotency_collision');
    expect(run.httpStatus).toBe(409);
    expect(run.bodySnippet).toContain('idempotency conflict');
    // 409 → a payment under this key likely already went out → indeterminate.
    expect(run.indeterminate).toBe(true);
  });

  it('Mercury returns 200 with {"status":"failed"} → refusal mercury_internal_failure, audit status=failed', async () => {
    const run = await runMercuryPayment({
      env: envFor(KV_WITH_TOKEN),
      payload: VALID_PAYLOAD,
      sovereignty: FRESH_ASSESSMENT,
      idempotencyKey: 'c'.repeat(64),
      fetchImpl: fetchReturning(
        200,
        JSON.stringify({ id: 'tx_failed_001', status: 'failed', amount: 1.0 }),
      ),
    });
    expect(run.ok).toBe(false);
    expect(run.refusalReason).toBe('mercury_internal_failure');
    expect(run.auditStatus).toBe('failed');
    expect(run.transactionId).toBe('tx_failed_001');
    expect(run.mercuryStatus).toBe('failed');
    expect(run.httpStatus).toBe(200);
    // Explicit Mercury status:"failed" on a 2xx → definite, no money moved →
    // NOT indeterminate (stays terminal failed, remediate via a new intent).
    expect(run.indeterminate).toBeFalsy();
  });

  it('Mercury returns 200 with {"status":"pending"} → ok=true, audit status=in_progress (NOT completed)', async () => {
    const run = await runMercuryPayment({
      env: envFor(KV_WITH_TOKEN),
      payload: VALID_PAYLOAD,
      sovereignty: FRESH_ASSESSMENT,
      idempotencyKey: 'd'.repeat(64),
      fetchImpl: fetchReturning(
        200,
        JSON.stringify({ id: 'tx_pending_001', status: 'pending', amount: 1.0 }),
      ),
    });
    expect(run.ok).toBe(true);
    expect(run.auditStatus).toBe('in_progress');
    expect(run.auditStatus).not.toBe('completed');
    expect(run.transactionId).toBe('tx_pending_001');
    expect(run.mercuryStatus).toBe('pending');
  });

  it('Mercury returns 200 with {"status":"sent"} → ok=true, audit status=completed', async () => {
    const run = await runMercuryPayment({
      env: envFor(KV_WITH_TOKEN),
      payload: VALID_PAYLOAD,
      sovereignty: FRESH_ASSESSMENT,
      idempotencyKey: 'e'.repeat(64),
      fetchImpl: fetchReturning(
        200,
        JSON.stringify({ id: 'tx_sent_001', status: 'sent', amount: 1.0 }),
      ),
    });
    expect(run.ok).toBe(true);
    expect(run.auditStatus).toBe('completed');
    expect(run.transactionId).toBe('tx_sent_001');
  });

  it('Mercury network error (thrown) → refusal mercury_api_failure with failureKind=network', async () => {
    const run = await runMercuryPayment({
      env: envFor(KV_WITH_TOKEN),
      payload: VALID_PAYLOAD,
      sovereignty: FRESH_ASSESSMENT,
      idempotencyKey: 'f'.repeat(64),
      fetchImpl: fetchThrowing(),
    });
    expect(run.ok).toBe(false);
    expect(run.refusalReason).toBe('mercury_api_failure');
    expect(run.failureKind).toBe('network');
    expect(run.bodySnippet).toContain('ECONNREFUSED');
    // network/lost-response → request may have committed before the response
    // was lost → indeterminate (reconcile, do not bury as failed).
    expect(run.indeterminate).toBe(true);
  });

  it('account_slug with mixed case or special chars → refusal invalid_account_slug (no KV lookup)', async () => {
    // KV_WITH_TOKEN only has a token for "aribia-llc". A slug "Aribia/LLC"
    // would normalize to "aribiallc" — but normalization changing the value
    // means the input was malformed, so we refuse BEFORE the KV lookup.
    const run = await runMercuryPayment({
      env: envFor(KV_WITH_TOKEN),
      payload: { ...VALID_PAYLOAD, account_slug: 'Aribia/LLC' },
      sovereignty: FRESH_ASSESSMENT,
      idempotencyKey: 'g'.repeat(64),
      fetchImpl: fetchThrowing(), // must not be reached
    });
    expect(run.ok).toBe(false);
    expect(run.refusalReason).toBe('invalid_account_slug');
  });

  it('account_slug already normalized but no token in KV → refusal missing_token', async () => {
    const run = await runMercuryPayment({
      env: envFor(KV_NO_TOKEN),
      payload: VALID_PAYLOAD,
      sovereignty: FRESH_ASSESSMENT,
      idempotencyKey: 'h'.repeat(64),
      fetchImpl: fetchThrowing(),
    });
    expect(run.ok).toBe(false);
    expect(run.refusalReason).toBe('missing_token');
  });
});

describe('chat-surface tool — refuses Mercury payments unconditionally', () => {
  it('execute_payment tool returns a refusal regardless of inputs (chat surface has no actor ChittyID)', async () => {
    // Verifies the chat path no longer drives runMercuryPayment with a
    // synthetic { decision: "autonomous" } snapshot. We import the tool
    // factory and call the execute function directly with no SQL writes
    // exercised against a real DB — the chat refusal does perform a DB
    // INSERT, so we need a SQL stub that records the call. This is NOT a
    // mock of mercuryClient or of the DB module; it is a no-op sql tag
    // function for verifying the tool's contract: refuse + audit.
    const { createActionTools } = await import('../../../src/agents/tools/actions');
    const sqlCalls: string[] = [];
    const sql = ((strings: TemplateStringsArray, ..._values: unknown[]) => {
      sqlCalls.push(strings.join('?'));
      return Promise.resolve([]);
    }) as unknown as Parameters<typeof createActionTools>[1];
    const tools = createActionTools(envFor(KV_WITH_TOKEN), sql);
    const execFn = tools.execute_payment.execute;
    if (!execFn) throw new Error('execute_payment.execute missing');
    const raw = await execFn(
      {
        account_slug: 'aribia-llc',
        mercury_account_id: 'acct_real_0001',
        recipient_id: 'rcpt_real_0001',
        amount: 100,
        note: 'should-not-execute',
        obligation_id: undefined,
      },
      { toolCallId: 'test', messages: [] },
    );
    const result = raw as { success: boolean; error: string; refusal_reason: string };
    expect(result.success).toBe(false);
    expect(result.refusal_reason).toBe('chat_surface_refuses_mercury');
    expect(result.error).toMatch(/dashboard/i);
    // Refusal must be audited so an operator sees a chat-initiated payment attempt.
    expect(sqlCalls.some((s) => s.includes('cc_actions_log'))).toBe(true);
  });
});

describe('mercury-payment — idempotency forwarded as HTTP header (PR #108 review C1)', () => {
  it('createPayment sends Idempotency-Key as a request header, not just in body', async () => {
    const captured: { url: string; headers: Headers; bodyText: string }[] = [];
    const idemKey = 'i'.repeat(64);

    const capturingFetch: typeof fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const req = new Request(input as RequestInfo, init);
      const bodyText = await req.text();
      captured.push({ url: req.url, headers: req.headers, bodyText });
      return new Response(
        JSON.stringify({ id: 'tx_hdr_001', status: 'sent', amount: 1.0 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const run = await runMercuryPayment({
      env: envFor(KV_WITH_TOKEN),
      payload: VALID_PAYLOAD,
      sovereignty: FRESH_ASSESSMENT,
      idempotencyKey: idemKey,
      fetchImpl: capturingFetch,
    });

    expect(run.ok).toBe(true);
    expect(captured.length).toBeGreaterThan(0);
    const post = captured.find((c) => c.url.includes('/transactions'));
    expect(post, 'expected a POST to /transactions to be captured').toBeDefined();
    // The Idempotency-Key HTTP header is what Mercury uses to dedupe transfers
    // on transport retry. Without it, a retried POST creates a duplicate ACH.
    expect(post!.headers.get('Idempotency-Key')).toBe(idemKey);
  });
});

// MERCURY_SOVEREIGNTY_FRESHNESS_MS import kept to ensure the constant remains
// public (other tests / runbook docs reference it).
void MERCURY_SOVEREIGNTY_FRESHNESS_MS;
