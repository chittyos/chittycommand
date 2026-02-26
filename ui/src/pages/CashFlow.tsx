import { useEffect, useState } from 'react';
import { api, type CashflowProjection, type ProjectionResult, type ScenarioResult, type Obligation, type PaymentPlan } from '../lib/api';
import { Card } from '../components/ui/Card';
import { MetricCard } from '../components/ui/MetricCard';
import { ActionButton } from '../components/ui/ActionButton';
import { PaymentPlanView } from '../components/planner/PaymentPlanView';
import { ScenarioOverride } from '../components/planner/ScenarioOverride';
import { StrategySelector } from '../components/planner/StrategySelector';
import { RevenueSources } from '../components/planner/RevenueSources';
import { formatCurrency, formatDate, cn } from '../lib/utils';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';

type CashFlowTab = 'projections' | 'planner' | 'revenue';

export function CashFlow() {
  const [activeTab, setActiveTab] = useState<CashFlowTab>('projections');
  const [projections, setProjections] = useState<CashflowProjection[]>([]);
  const [summary, setSummary] = useState<ProjectionResult | null>(null);
  const [obligations, setObligations] = useState<Obligation[]>([]);
  const [scenario, setScenario] = useState<ScenarioResult | null>(null);
  const [deferIds, setDeferIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    Promise.all([
      api.getCashflowProjections(),
      api.getObligations({ status: 'pending' }),
    ])
      .then(([proj, obs]) => {
        setProjections(proj);
        setObligations(obs);
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const result = await api.generateCashflowProjections();
      setSummary(result);
      const proj = await api.getCashflowProjections();
      setProjections(proj);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Generation failed');
    } finally {
      setGenerating(false);
    }
  };

  const toggleDefer = (id: string) => {
    setDeferIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setScenario(null);
  };

  const runScenario = async () => {
    if (deferIds.size === 0) return;
    try {
      const result = await api.runCashflowScenario(Array.from(deferIds));
      setScenario(result);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Scenario failed');
    }
  };

  // Chart data
  const chartData = projections.map((p) => ({
    date: new Date(p.projection_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    balance: parseFloat(p.projected_balance),
    inflow: parseFloat(p.projected_inflow),
    outflow: parseFloat(p.projected_outflow),
  }));

  const upcoming = obligations
    .filter((o) => o.status === 'pending' || o.status === 'overdue')
    .sort((a, b) => a.due_date.localeCompare(b.due_date))
    .slice(0, 20);

  if (error && projections.length === 0) {
    return (
      <div className="text-center py-20">
        <p className="text-urgency-red text-lg font-medium">Failed to load cash flow data</p>
        <p className="text-card-muted mt-2">{error}</p>
        <ActionButton label="Generate Projections" onClick={handleGenerate} className="mt-4" />
      </div>
    );
  }

  // Payment planner state
  const [plan, setPlan] = useState<PaymentPlan | null>(null);
  const [planStrategy, setPlanStrategy] = useState<'optimal' | 'conservative' | 'aggressive'>('optimal');
  const [planLoading, setPlanLoading] = useState(false);
  const [planDeferIds, setPlanDeferIds] = useState<string[]>([]);

  const handleGeneratePlan = async () => {
    setPlanLoading(true);
    try {
      const result = await api.generatePaymentPlan({ strategy: planStrategy });
      setPlan(result);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Plan generation failed');
    } finally {
      setPlanLoading(false);
    }
  };

  const handleDeferInPlan = async (obligationId: string) => {
    const newDeferIds = [...planDeferIds, obligationId];
    setPlanDeferIds(newDeferIds);
    try {
      const result = await api.simulatePaymentPlan({ strategy: planStrategy, defer_ids: newDeferIds });
      setPlan(result);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Simulation failed');
    }
  };

  const handleScenarioSimulate = async (overrides: {
    defer_ids?: string[];
    pay_early_ids?: string[];
    custom_amounts?: Record<string, number>;
  }) => {
    try {
      const result = await api.simulatePaymentPlan({ strategy: planStrategy, ...overrides });
      setPlan(result);
      // Sync planDeferIds with scenario overrides
      if (overrides.defer_ids) {
        setPlanDeferIds(overrides.defer_ids);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Simulation failed');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h1 className="text-lg lg:text-xl font-bold text-chrome-text">Cash Flow</h1>
        {activeTab === 'projections' && (
          <ActionButton
            label={generating ? 'Generating...' : 'Regenerate'}
            onClick={handleGenerate}
            loading={generating}
          />
        )}
        {activeTab === 'planner' && (
          <ActionButton
            label={planLoading ? 'Planning...' : 'Generate Plan'}
            onClick={handleGeneratePlan}
            loading={planLoading}
          />
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-card-hover rounded-lg p-1 border border-card-border">
        {(['projections', 'planner', 'revenue'] as CashFlowTab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              'flex-1 px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
              activeTab === tab
                ? 'bg-chitty-600 text-white'
                : 'text-card-muted hover:text-card-text',
            )}
          >
            {tab === 'projections' ? 'Forecast' : tab === 'planner' ? 'Payment Planner' : 'Revenue'}
          </button>
        ))}
      </div>

      {/* Payment Planner Tab */}
      {activeTab === 'planner' && (
        <div className="space-y-4">
          <StrategySelector value={planStrategy} onChange={setPlanStrategy} disabled={planLoading} />
          {plan ? (
            <>
              <PaymentPlanView plan={plan} onDeferItem={handleDeferInPlan} />
              <ScenarioOverride plan={plan} strategy={planStrategy} onSimulate={handleScenarioSimulate} />
            </>
          ) : (
            <Card className="text-center py-8">
              <p className="text-card-muted">Select a strategy and click "Generate Plan" to create a payment schedule.</p>
              <p className="text-card-muted text-sm mt-1">The planner uses real balances, obligations, and revenue data.</p>
            </Card>
          )}
        </div>
      )}

      {/* Revenue Tab */}
      {activeTab === 'revenue' && <RevenueSources />}

      {/* Projections Tab */}
      {activeTab === 'projections' && summary && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 lg:gap-3">
          <MetricCard label="Starting Balance" value={formatCurrency(summary.starting_balance)} valueClassName="text-urgency-green" />
          <MetricCard label="Ending Balance" value={formatCurrency(summary.ending_balance)} valueClassName="text-urgency-green" />
          <MetricCard label="Lowest Point" value={formatCurrency(summary.lowest_balance)} valueClassName={summary.lowest_balance < 0 ? 'text-urgency-red' : 'text-urgency-amber'} />
        </div>
      )}

      {activeTab === 'projections' && (
        <>
          {loading ? (
            <div className="text-center py-20 text-chrome-muted">Loading projections...</div>
          ) : chartData.length === 0 ? (
            <Card className="text-center py-12">
              <p className="text-card-muted">No projections yet.</p>
              <ActionButton label="Generate 90-Day Forecast" onClick={handleGenerate} className="mt-4" />
            </Card>
          ) : (
            <>
              {/* Recharts Area Chart */}
              <Card>
                <ResponsiveContainer width="100%" height={280}>
                  <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="balanceGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="var(--chitty-500)" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="var(--chitty-500)" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--card-text-muted)' }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: 'var(--card-text-muted)' }} tickLine={false} axisLine={false} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
                    <Tooltip
                      contentStyle={{ backgroundColor: 'var(--chrome-bg)', border: '1px solid var(--chrome-border)', borderRadius: '8px', fontSize: '12px' }}
                      labelStyle={{ color: 'var(--chrome-text)' }}
                      itemStyle={{ color: 'var(--chrome-text-muted)' }}
                      formatter={(value?: number) => [value != null ? formatCurrency(value) : '', '']}
                    />
                    <ReferenceLine y={0} stroke="var(--urgency-red)" strokeDasharray="3 3" strokeOpacity={0.5} />
                    <Area type="monotone" dataKey="balance" stroke="var(--chitty-500)" fill="url(#balanceGradient)" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </Card>

              {/* Outflows table */}
              <Card>
                <h2 className="font-semibold text-card-text mb-3">Projected Outflows</h2>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-card-muted border-b border-card-border">
                      <th className="text-left py-2 font-medium">Date</th>
                      <th className="text-right py-2 font-medium">Outflow</th>
                      <th className="text-right py-2 font-medium">Balance After</th>
                    </tr>
                  </thead>
                  <tbody>
                    {chartData.filter((e) => e.outflow > 0).slice(0, 15).map((entry) => (
                      <tr key={entry.date} className="border-b border-card-border/50 last:border-0">
                        <td className="py-2 text-card-muted">{entry.date}</td>
                        <td className="py-2 text-urgency-red text-right font-mono">-{formatCurrency(entry.outflow)}</td>
                        <td className={`py-2 text-right font-mono ${entry.balance < 0 ? 'text-urgency-red' : 'text-card-text'}`}>
                          {formatCurrency(entry.balance)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </>
          )}

          {/* Scenario Panel */}
          <Card>
            <h2 className="font-semibold text-card-text mb-2">Scenario: What If I Defer?</h2>
            <p className="text-card-muted text-sm mb-3">Select obligations to defer and see the impact on your cash position.</p>

            <div className="space-y-1 max-h-64 overflow-y-auto mb-4">
              {upcoming.map((ob) => (
                <label key={ob.id} className="flex items-center gap-3 py-1.5 px-2 rounded-lg hover:bg-card-hover cursor-pointer">
                  <input
                    type="checkbox"
                    checked={deferIds.has(ob.id)}
                    onChange={() => toggleDefer(ob.id)}
                    className="rounded border-card-border"
                  />
                  <span className="text-card-text text-sm flex-1">{ob.payee}</span>
                  <span className="text-card-muted text-sm">{formatDate(ob.due_date)}</span>
                  <span className="text-urgency-red text-sm font-mono">{formatCurrency(parseFloat(ob.amount_due || ob.amount_minimum || '0'))}</span>
                </label>
              ))}
            </div>

            <div className="flex items-center gap-3">
              <ActionButton
                label={`Run Scenario (${deferIds.size} deferred)`}
                onClick={runScenario}
                disabled={deferIds.size === 0}
              />
              {deferIds.size > 0 && (
                <button onClick={() => { setDeferIds(new Set()); setScenario(null); }} className="text-card-muted text-sm hover:text-card-text">
                  Clear
                </button>
              )}
            </div>

            {scenario && (
              <div className="mt-4 grid grid-cols-2 lg:grid-cols-4 gap-2 lg:gap-3">
                <MetricCard label="Without Deferral" value={formatCurrency(scenario.original_balance)} valueClassName={scenario.original_balance < 0 ? 'text-urgency-red' : 'text-urgency-green'} />
                <MetricCard label="With Deferral" value={formatCurrency(scenario.projected_balance)} valueClassName={scenario.projected_balance < 0 ? 'text-urgency-red' : 'text-urgency-green'} />
                <MetricCard label="Savings" value={formatCurrency(scenario.savings_from_deferral)} valueClassName="text-urgency-amber" />
                <MetricCard label="Items Deferred" value={String(scenario.deferred_items.length)} />
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
