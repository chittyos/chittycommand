import { describe, expect, it, vi } from 'vitest';
import executor, {
  LEGAL_MATTER_BOOTSTRAP_INTENT,
  runLegalMatterBootstrap,
} from '../../meta/executors/legal-matter-bootstrap';
import type { ExecutorContext } from '../../meta/executors/types';

describe('legal_matter_bootstrap executor', () => {
  it('returns a validated read-only ChittyCounsel bootstrap response', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain('/case/03-1-USA-0010-L-2602-0-01/bootstrap');
      return Response.json({
        found: true,
        bootstrap: {
          case_found: true,
          phases: ['BOOTSTRAP', 'DISCOVER'],
          queues: ['INITIAL_ANALYSIS'],
        },
        case: { chitty_id: '03-1-USA-0010-L-2602-0-01' },
        provenance: { worker: 'chittycounsel', version: '0.2.0' },
      });
    }) as typeof fetch;

    const result = await runLegalMatterBootstrap(
      { case_chitty_id: '03-1-USA-0010-L-2602-0-01' },
      { counselUrl: 'https://counsel.example.test/', fetchFn },
    );

    expect(result.success).toBe(true);
    expect(result.found).toBe(true);
    expect(result.provenance).toMatchObject({ worker: 'chittycounsel' });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('fails closed on upstream transport failure', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const result = await runLegalMatterBootstrap(
      { case_chitty_id: '03-1-USA-0010-L-2602-0-01' },
      { fetchFn },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('ChittyCounsel unavailable');
  });

  it('refuses intents outside privileged + legalink classification', async () => {
    const ctx = {
      intent: {
        id: 'intent-test',
        intentType: LEGAL_MATTER_BOOTSTRAP_INTENT,
        payload: { case_chitty_id: '03-1-USA-0010-L-2602-0-01' },
        privilege: 'public',
        space: 'business',
      },
    } as unknown as ExecutorContext;

    const result = await executor.run(ctx);

    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toContain('classification mismatch');
  });

  it('rejects an invalid payload before any upstream call', async () => {
    const ctx = {
      intent: {
        id: 'intent-test',
        intentType: LEGAL_MATTER_BOOTSTRAP_INTENT,
        payload: {},
        privilege: 'privileged',
        space: 'legalink',
      },
      env: {},
    } as unknown as ExecutorContext;

    const result = await executor.run(ctx);

    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toContain('case_chitty_id');
  });
});
