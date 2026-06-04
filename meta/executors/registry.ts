/**
 * Executor registry — map intent_type → IntentExecutor.
 *
 * Executors self-register at module load via top-level `registerExecutor()`.
 * The dispatcher (meta/executors/dispatch.ts) looks executors up by
 * intent_type; absence is a wiring bug, not a runtime error.
 *
 * @canonical-uri chittycanon://docs/architecture/chittycommand/ADR-001
 */

import type { IntentExecutor } from './types';

const REGISTRY = new Map<string, IntentExecutor>();

export function registerExecutor(executor: IntentExecutor): void {
  if (!executor.intentType || executor.intentType.trim().length === 0) {
    throw new Error('[meta/executors] registerExecutor: intentType is required');
  }
  if (REGISTRY.has(executor.intentType)) {
    const existing = REGISTRY.get(executor.intentType)!;
    if (existing === executor) return; // idempotent same-module reload
    throw new Error(
      `[meta/executors] Duplicate executor for intent_type='${executor.intentType}' ` +
        `(existing: ${existing.canonicalUri}, new: ${executor.canonicalUri})`,
    );
  }
  REGISTRY.set(executor.intentType, executor);
}

export function getExecutor(intentType: string): IntentExecutor | undefined {
  return REGISTRY.get(intentType);
}

export function listExecutors(): IntentExecutor[] {
  return Array.from(REGISTRY.values());
}

/** Test-only: clear the registry. */
export function __resetRegistryForTests(): void {
  REGISTRY.clear();
}
