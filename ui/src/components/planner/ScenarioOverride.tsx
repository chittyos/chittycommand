import { useState, useMemo } from 'react';
import { formatCurrency, formatDate, cn } from '../../lib/utils';
import type { PaymentPlan, ScheduleEntry } from '../../lib/api';
import { Card } from '../ui/Card';
import { ActionButton } from '../ui/ActionButton';

type ActionType = 'pay_full' | 'pay_minimum' | 'defer';

interface ObligationOverride {
  action: ActionType;
  payEarly: boolean;
}

interface ScenarioOverrideProps {
  plan: PaymentPlan;
  strategy: 'optimal' | 'conservative' | 'aggressive';
  onSimulate: (overrides: {
    defer_ids?: string[];
    pay_early_ids?: string[];
    custom_amounts?: Record<string, number>;
  }) => Promise<void>;
}

interface UniqueObligation {
  obligation_id: string;
  payee: string;
  amount: number;
  date: string;
  action: string;
}

export function ScenarioOverride({ plan, strategy: _strategy, onSimulate }: ScenarioOverrideProps) {
  const [overrides, setOverrides] = useState<Record<string, ObligationOverride>>({});
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  // Parse and dedupe schedule — memoized to avoid JSON.parse on every render
  const uniqueObligations = useMemo<UniqueObligation[]>(() => {
    let schedule: ScheduleEntry[];
    try {
      const raw = typeof plan.schedule === 'string' ? JSON.parse(plan.schedule) : plan.schedule;
      schedule = Array.isArray(raw) ? raw : [];
    } catch (e) {
      console.error('[ScenarioOverride] Failed to parse plan.schedule', e);
      return [];
    }
    const seen = new Map<string, UniqueObligation>();
    for (const entry of schedule) {
      if (!entry.obligation_id) continue;
      if (!seen.has(entry.obligation_id)) {
        seen.set(entry.obligation_id, {
          obligation_id: entry.obligation_id,
          payee: entry.payee,
          amount: entry.amount,
          date: entry.date,
          action: entry.action,
        });
      }
    }
    return Array.from(seen.values());
  }, [plan.schedule]);

  const getOverride = (id: string): ObligationOverride | undefined => overrides[id];

  const getEffectiveAction = (ob: UniqueObligation): ActionType => {
    const override = getOverride(ob.obligation_id);
    if (override) return override.action;
    // Map original action to ActionType
    if (ob.action === 'pay_full' || ob.action === 'pay_minimum' || ob.action === 'defer') {
      return ob.action as ActionType;
    }
    // at_risk maps to defer for override purposes
    return 'defer';
  };

  const isPayEarly = (ob: UniqueObligation): boolean => {
    return getOverride(ob.obligation_id)?.payEarly ?? false;
  };

  const setAction = (id: string, action: ActionType) => {
    setOverrides((prev) => ({
      ...prev,
      [id]: {
        action,
        payEarly: action === 'defer' ? false : (prev[id]?.payEarly ?? false),
      },
    }));
  };

  const togglePayEarly = (id: string) => {
    setOverrides((prev) => ({
      ...prev,
      [id]: {
        action: prev[id]?.action ?? 'pay_full',
        payEarly: !(prev[id]?.payEarly ?? false),
      },
    }));
  };

  const clearOverride = (id: string) => {
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const hasChanges = (ob: UniqueObligation): boolean => {
    const override = overrides[ob.obligation_id];
    if (!override) return false;
    const originalAction = ob.action === 'at_risk' ? 'defer' : ob.action;
    return override.action !== originalAction || override.payEarly;
  };

  // Compute summary counts
  const changeSummary = useMemo(() => {
    let deferred = 0;
    let payEarly = 0;
    let amountChanges = 0;

    for (const ob of uniqueObligations) {
      const override = overrides[ob.obligation_id];
      if (!override) continue;
      const originalAction = ob.action === 'at_risk' ? 'defer' : ob.action;
      const changed = override.action !== originalAction || override.payEarly;
      if (!changed) continue;

      if (override.action === 'defer' && originalAction !== 'defer') deferred++;
      if (override.payEarly) payEarly++;
      if (override.action !== originalAction && override.action !== 'defer') amountChanges++;
    }

    return { deferred, payEarly, amountChanges, total: deferred + payEarly + amountChanges };
  }, [overrides, uniqueObligations]);

  const handleApply = async () => {
    const deferIds: string[] = [];
    const payEarlyIds: string[] = [];
    const customAmounts: Record<string, number> = {};

    for (const ob of uniqueObligations) {
      if (!hasChanges(ob)) continue;
      const override = getOverride(ob.obligation_id);
      if (!override) continue;

      if (override.action === 'defer') {
        deferIds.push(ob.obligation_id);
      }
      if (override.payEarly) {
        payEarlyIds.push(ob.obligation_id);
      }
      // When switching from pay_full to pay_minimum, set custom amount to 0
      // to signal minimum payment. The backend interprets this accordingly.
      if (override.action === 'pay_minimum' && ob.action === 'pay_full') {
        customAmounts[ob.obligation_id] = 0;
      }
    }

    setApplying(true);
    setApplyError(null);
    try {
      await onSimulate({
        defer_ids: deferIds.length > 0 ? deferIds : undefined,
        pay_early_ids: payEarlyIds.length > 0 ? payEarlyIds : undefined,
        custom_amounts: Object.keys(customAmounts).length > 0 ? customAmounts : undefined,
      });
    } catch (e: unknown) {
      setApplyError(e instanceof Error ? e.message : 'Simulation failed');
    } finally {
      setApplying(false);
    }
  };

  const clearAll = () => setOverrides({});

  if (uniqueObligations.length === 0) return null;

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-card-text text-sm font-semibold">Scenario Overrides</h3>
          <p className="text-card-muted text-xs mt-0.5">
            Adjust actions per payment to see the impact on your balance curve.
          </p>
        </div>
        {changeSummary.total > 0 && (
          <button
            onClick={clearAll}
            className="text-xs text-card-muted hover:text-card-text transition-colors"
          >
            Reset all
          </button>
        )}
      </div>

      <div className="space-y-1 max-h-80 overflow-y-auto">
        {uniqueObligations.map((ob) => {
          const effectiveAction = getEffectiveAction(ob);
          const payEarly = isPayEarly(ob);
          const changed = hasChanges(ob);

          return (
            <div
              key={ob.obligation_id}
              className={cn(
                'flex flex-col sm:flex-row sm:items-center gap-2 py-2 px-2 rounded-lg',
                changed ? 'bg-chitty-50/50 border border-chitty-300' : 'hover:bg-card-hover',
              )}
            >
              {/* Obligation info */}
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${actionDot(effectiveAction)}`} />
                <span className="text-sm text-card-text truncate">{ob.payee}</span>
                <span className="text-xs text-card-muted shrink-0">{formatDate(ob.date)}</span>
                <span className="text-sm font-mono text-card-text shrink-0">
                  {ob.amount > 0 ? formatCurrency(ob.amount) : '--'}
                </span>
              </div>

              {/* Override controls */}
              <div className="flex items-center gap-1.5 shrink-0 ml-4 sm:ml-0">
                {/* Action toggle buttons */}
                {(['pay_full', 'pay_minimum', 'defer'] as ActionType[]).map((action) => (
                  <button
                    key={action}
                    onClick={() => setAction(ob.obligation_id, action)}
                    className={cn(
                      'text-xs px-2 py-1 rounded transition-colors',
                      effectiveAction === action
                        ? actionActiveStyle(action)
                        : 'bg-card-hover text-card-muted hover:text-card-text',
                    )}
                  >
                    {actionLabel(action)}
                  </button>
                ))}

                {/* Pay early toggle */}
                {effectiveAction !== 'defer' && (
                  <button
                    onClick={() => togglePayEarly(ob.obligation_id)}
                    className={cn(
                      'text-xs px-2 py-1 rounded transition-colors',
                      payEarly
                        ? 'bg-blue-100 text-blue-700'
                        : 'bg-card-hover text-card-muted hover:text-card-text',
                    )}
                  >
                    Early
                  </button>
                )}

                {/* Clear single override */}
                {changed && (
                  <button
                    onClick={() => clearOverride(ob.obligation_id)}
                    className="text-xs text-card-muted hover:text-card-text ml-1"
                    title="Reset"
                  >
                    &times;
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Summary + apply */}
      <div className="mt-3 pt-3 border-t border-card-border flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <p className="text-xs text-card-muted">
          {changeSummary.total === 0
            ? 'No changes yet'
            : [
                changeSummary.deferred > 0 && `${changeSummary.deferred} deferred`,
                changeSummary.payEarly > 0 && `${changeSummary.payEarly} pay early`,
                changeSummary.amountChanges > 0 && `${changeSummary.amountChanges} amount change${changeSummary.amountChanges !== 1 ? 's' : ''}`,
              ]
                .filter(Boolean)
                .join(', ')}
        </p>
        <div className="flex flex-col items-end gap-1">
          <ActionButton
            label={applying ? 'Simulating...' : `Apply Overrides (${changeSummary.total})`}
            onClick={handleApply}
            loading={applying}
            disabled={changeSummary.total === 0}
          />
          {applyError && <p className="text-urgency-red text-xs">{applyError}</p>}
        </div>
      </div>
    </Card>
  );
}

function actionDot(action: ActionType): string {
  switch (action) {
    case 'pay_full': return 'bg-green-500';
    case 'pay_minimum': return 'bg-amber-500';
    case 'defer': return 'bg-gray-400';
  }
}

function actionActiveStyle(action: ActionType): string {
  switch (action) {
    case 'pay_full': return 'bg-green-100 text-green-700';
    case 'pay_minimum': return 'bg-amber-100 text-amber-700';
    case 'defer': return 'bg-gray-100 text-gray-600';
  }
}

function actionLabel(action: ActionType): string {
  switch (action) {
    case 'pay_full': return 'Full';
    case 'pay_minimum': return 'Min';
    case 'defer': return 'Defer';
  }
}
