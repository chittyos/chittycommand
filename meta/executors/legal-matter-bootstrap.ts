/**
 * Executor: legal_matter_bootstrap
 *
 * Read-only bootstrap projection for a governed legal matter. Delegates case
 * discovery/readiness to ChittyCounsel and returns the result for the dispatcher
 * to record in cc_actions_log. It never writes evidence, facts, or matter state.
 *
 * Canonical URI:
 * chittycanon://core/services/chittycommand/executors/legal_matter_bootstrap
 */

import { z } from 'zod';
import type { ExecutorContext, ExecutorRunOutput, IntentExecutor } from './types';
import { registerExecutor } from './registry';

export const LEGAL_MATTER_BOOTSTRAP_INTENT = 'legal_matter_bootstrap';

const DEFAULT_COUNSEL_URL = 'https://counsel.chitty.cc';
const BOOTSTRAP_TIMEOUT_MS = 10_000;

export const legalMatterBootstrapSchema = z.object({
  case_chitty_id: z.string().min(1).max(128),
});

export type LegalMatterBootstrapArgs = z.infer<typeof legalMatterBootstrapSchema>;

interface BootstrapFetchOptions {
  counselUrl?: string;
  fetchFn?: typeof fetch;
}

export async function runLegalMatterBootstrap(
  args: LegalMatterBootstrapArgs,
  options: BootstrapFetchOptions = {},
): Promise<{
  success: boolean;
  found?: boolean;
  bootstrap?: Record<string, unknown>;
  case?: Record<string, unknown> | null;
  provenance?: Record<string, unknown>;
  error?: string;
  upstream_status?: number;
}> {
  const counselUrl = (options.counselUrl || DEFAULT_COUNSEL_URL).replace(/\/$/, '');
  const fetchFn = options.fetchFn ?? fetch;
  const url =
    `${counselUrl}/case/${encodeURIComponent(args.case_chitty_id)}/bootstrap`;

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-ChittyOS-Caller': 'chittycommand',
      },
      signal: AbortSignal.timeout(BOOTSTRAP_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      success: false,
      error: `ChittyCounsel unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      success: false,
      upstream_status: response.status,
      error: 'ChittyCounsel returned non-JSON bootstrap response',
    };
  }

  if (!response.ok) {
    const upstream = body as Record<string, unknown>;
    return {
      success: false,
      upstream_status: response.status,
      error:
        typeof upstream?.error === 'string'
          ? upstream.error
          : `ChittyCounsel bootstrap failed with HTTP ${response.status}`,
    };
  }

  const parsed = z.object({
    found: z.boolean(),
    bootstrap: z.record(z.string(), z.unknown()),
    case: z.record(z.string(), z.unknown()).nullable().optional(),
    provenance: z.record(z.string(), z.unknown()),
  }).safeParse(body);

  if (!parsed.success) {
    return {
      success: false,
      upstream_status: response.status,
      error: 'ChittyCounsel bootstrap response failed contract validation',
    };
  }

  return {
    success: true,
    found: parsed.data.found,
    bootstrap: parsed.data.bootstrap,
    case: parsed.data.case ?? null,
    provenance: parsed.data.provenance,
  };
}

const executor: IntentExecutor = {
  intentType: LEGAL_MATTER_BOOTSTRAP_INTENT,
  canonicalUri:
    'chittycanon://core/services/chittycommand/executors/legal_matter_bootstrap',

  async run(ctx: ExecutorContext): Promise<ExecutorRunOutput> {
    if (ctx.intent.privilege !== 'privileged' || ctx.intent.space !== 'legalink') {
      return {
        ok: false,
        description: 'Legal matter bootstrap refused: intent must be privileged + legalink',
        actionType: 'legal_matter_bootstrap',
        targetType: 'case',
        targetId: null,
        status: 'failed',
        errorMessage: 'classification mismatch: expected privilege=privileged and space=legalink',
      };
    }

    const parsed = legalMatterBootstrapSchema.safeParse(ctx.intent.payload);
    if (!parsed.success) {
      return {
        ok: false,
        description: `payload validation failed for intent ${ctx.intent.id}`,
        actionType: 'legal_matter_bootstrap',
        targetType: 'case',
        targetId: null,
        status: 'failed',
        errorMessage: parsed.error.message,
      };
    }

    const env = ctx.env as typeof ctx.env & { CHITTYCOUNSEL_URL?: string };
    const result = await runLegalMatterBootstrap(parsed.data, {
      counselUrl: env.CHITTYCOUNSEL_URL,
    });

    if (!result.success) {
      return {
        ok: false,
        description: result.error ?? 'ChittyCounsel bootstrap failed',
        actionType: 'legal_matter_bootstrap',
        targetType: 'case',
        targetId: parsed.data.case_chitty_id,
        status: 'failed',
        errorMessage: result.error ?? 'ChittyCounsel bootstrap failed',
        responsePayload: result.upstream_status
          ? { upstream_status: result.upstream_status }
          : undefined,
      };
    }

    return {
      ok: true,
      description: `Read-only legal matter bootstrap completed for ${parsed.data.case_chitty_id}`,
      actionType: 'legal_matter_bootstrap',
      targetType: 'case',
      targetId: parsed.data.case_chitty_id,
      status: 'completed',
      responsePayload: {
        found: result.found,
        bootstrap: result.bootstrap,
        case: result.case,
        provenance: result.provenance,
      },
      metadata: {
        source_service: 'chittycounsel',
        read_only: true,
        privilege: 'privileged',
        space: 'legalink',
      },
    };
  },
};

registerExecutor(executor);

export default executor;
