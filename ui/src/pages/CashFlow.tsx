import { useEffect, useState } from 'react';
import { api, type CashflowProjection, type ProjectionResult, type ScenarioResult, type Obligation } from '../lib/api';
import { formatCurrency, formatDate } from '../lib/utils';

export function CashFlow() {
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
    } catch (e: any) {
      setError(e.message);
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
    } catch (e: any) {
      setError(e.message);
    }
  };

  if (error && projections.length === 0) {
    return (
      <div className="text-center py-20">
        <p className="text-red-400 text-lg">Failed to load cash flow data</p>
        <p className="text-gray-500 mt-2">{error}</p>
        <button onClick={handleGenerate} className="mt-4 px-4 py-2 bg-chitty-600 text-white rounded hover:bg-chitty-500">
          Generate Projections
        </button>
      </div>
    );
  }

  // Parse projections into chart-friendly format
  const entries = projections.map((p) => ({
    date: p.projection_date,
    balance: parseFloat(p.projected_balance),
    inflow: parseFloat(p.projected_inflow),
    outflow: parseFloat(p.projected_outflow),
    obligations: parseOblArray(p.obligations),
    confidence: parseFloat(p.confidence),
  }));

  const balances = entries.map((e) => e.balance);
  const minBalance = balances.length ? Math.min(...balances) : 0;
  const maxBalance = balances.length ? Math.max(...balances) : 1;
  const range = maxBalance - minBalance || 1;

  // Upcoming obligations for scenario panel
  const upcoming = obligations
    .filter((o) => o.status === 'pending' || o.status === 'overdue')
    .sort((a, b) => a.due_date.localeCompare(b.due_date))
    .slice(0, 20);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-white">Cash Flow Forecast</h1>
        <div className="flex items-center gap-4">
          {summary && (
            <div className="flex gap-4 text-sm">
              <div className="text-gray-400">Start: <span className="text-green-400 font-mono">{formatCurrency(summary.starting_balance)}</span></div>
              <div className="text-gray-400">End: <span className="text-green-400 font-mono">{formatCurrency(summary.ending_balance)}</span></div>
              <div className="text-gray-400">Low: <span className={`font-mono ${summary.lowest_balance < 0 ? 'text-red-400' : 'text-yellow-400'}`}>{formatCurrency(summary.lowest_balance)}</span></div>
            </div>
          )}
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="px-3 py-1.5 bg-chitty-600 text-white text-sm rounded hover:bg-chitty-500 disabled:opacity-50"
          >
            {generating ? 'Generating...' : 'Regenerate'}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-20 text-gray-400">Loading projections...</div>
      ) : entries.length === 0 ? (
        <div className="text-center py-20">
          <p className="text-gray-400">No projections yet.</p>
          <button onClick={handleGenerate} className="mt-4 px-4 py-2 bg-chitty-600 text-white rounded hover:bg-chitty-500">
            Generate 90-Day Forecast
          </button>
        </div>
      ) : (
        <>
          {/* Bar chart */}
          <div className="bg-[#161822] rounded-lg border border-gray-800 p-4">
            <div className="flex items-end gap-px h-48">
              {entries.map((entry, i) => {
                const height = ((entry.balance - minBalance) / range) * 100;
                const isNegative = entry.balance < 0;
                const hasOutflow = entry.outflow > 0;
                const opacity = entry.confidence >= 0.8 ? '' : entry.confidence >= 0.6 ? 'opacity-80' : 'opacity-60';
                return (
                  <div key={i} className="group relative flex-1 min-w-0">
                    <div
                      className={`w-full rounded-t-sm transition-colors ${
                        isNegative ? 'bg-red-500' : hasOutflow ? 'bg-orange-500' : 'bg-chitty-600'
                      } ${opacity} group-hover:brightness-125`}
                      style={{ height: `${Math.max(height, 2)}%` }}
                    />
                    <div className="hidden group-hover:block absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs whitespace-nowrap z-10">
                      <p className="text-white">{formatDate(entry.date)}</p>
                      <p className={isNegative ? 'text-red-400' : 'text-green-400'}>{formatCurrency(entry.balance)}</p>
                      {entry.inflow > 0 && <p className="text-green-400">+{formatCurrency(entry.inflow)} in</p>}
                      {entry.outflow > 0 && <p className="text-red-400">-{formatCurrency(entry.outflow)} out</p>}
                      {entry.obligations.map((o, j) => (
                        <p key={j} className="text-gray-400">{o}</p>
                      ))}
                      <p className="text-gray-500">{Math.round(entry.confidence * 100)}% confidence</p>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between text-xs text-gray-500 mt-2">
              <span>Today</span>
              <span>30 days</span>
              <span>60 days</span>
              <span>90 days</span>
            </div>
          </div>

          {/* Outflows table */}
          <div className="bg-[#161822] rounded-lg border border-gray-800 p-4">
            <h2 className="text-white font-semibold mb-3">Projected Outflows</h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-500 border-b border-gray-800">
                  <th className="text-left py-2">Date</th>
                  <th className="text-left py-2">Obligations</th>
                  <th className="text-right py-2">Outflow</th>
                  <th className="text-right py-2">Balance After</th>
                  <th className="text-right py-2">Confidence</th>
                </tr>
              </thead>
              <tbody>
                {entries.filter((e) => e.outflow > 0).map((entry, i) => (
                  <tr key={i} className="border-b border-gray-800 last:border-0">
                    <td className="py-2 text-gray-400">{formatDate(entry.date)}</td>
                    <td className="py-2 text-white">{entry.obligations.join(', ') || '-'}</td>
                    <td className="py-2 text-red-400 text-right font-mono">-{formatCurrency(entry.outflow)}</td>
                    <td className={`py-2 text-right font-mono ${entry.balance < 0 ? 'text-red-400' : 'text-green-400'}`}>
                      {formatCurrency(entry.balance)}
                    </td>
                    <td className="py-2 text-right text-gray-500">{Math.round(entry.confidence * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Scenario: "What if I defer...?" */}
      <div className="bg-[#161822] rounded-lg border border-gray-800 p-4">
        <h2 className="text-white font-semibold mb-3">Scenario: What If I Defer?</h2>
        <p className="text-gray-400 text-sm mb-3">Select obligations to defer and see the impact on your cash position.</p>

        <div className="space-y-1 max-h-64 overflow-y-auto mb-4">
          {upcoming.map((ob) => (
            <label key={ob.id} className="flex items-center gap-3 py-1.5 px-2 rounded hover:bg-gray-800 cursor-pointer">
              <input
                type="checkbox"
                checked={deferIds.has(ob.id)}
                onChange={() => toggleDefer(ob.id)}
                className="rounded border-gray-600"
              />
              <span className="text-white text-sm flex-1">{ob.payee}</span>
              <span className="text-gray-400 text-sm">{formatDate(ob.due_date)}</span>
              <span className="text-red-400 text-sm font-mono">{formatCurrency(parseFloat(ob.amount_due || ob.amount_minimum || '0'))}</span>
            </label>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={runScenario}
            disabled={deferIds.size === 0}
            className="px-3 py-1.5 bg-yellow-600 text-white text-sm rounded hover:bg-yellow-500 disabled:opacity-50"
          >
            Run Scenario ({deferIds.size} deferred)
          </button>
          {deferIds.size > 0 && (
            <button onClick={() => { setDeferIds(new Set()); setScenario(null); }} className="text-gray-400 text-sm hover:text-white">
              Clear
            </button>
          )}
        </div>

        {scenario && (
          <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-gray-800 rounded p-3">
              <div className="text-gray-400 text-xs">Without Deferral</div>
              <div className={`text-lg font-mono ${scenario.original_balance < 0 ? 'text-red-400' : 'text-green-400'}`}>
                {formatCurrency(scenario.original_balance)}
              </div>
            </div>
            <div className="bg-gray-800 rounded p-3">
              <div className="text-gray-400 text-xs">With Deferral</div>
              <div className={`text-lg font-mono ${scenario.projected_balance < 0 ? 'text-red-400' : 'text-green-400'}`}>
                {formatCurrency(scenario.projected_balance)}
              </div>
            </div>
            <div className="bg-gray-800 rounded p-3">
              <div className="text-gray-400 text-xs">Savings</div>
              <div className="text-lg font-mono text-yellow-400">{formatCurrency(scenario.savings_from_deferral)}</div>
            </div>
            <div className="bg-gray-800 rounded p-3">
              <div className="text-gray-400 text-xs">Items Deferred</div>
              <div className="text-lg font-mono text-white">{scenario.deferred_items.length}</div>
            </div>
          </div>
        )}
      </div>

      <div className="bg-[#161822] rounded-lg border border-gray-800 p-4">
        <h2 className="text-white font-semibold mb-2">Legend</h2>
        <div className="flex gap-6 text-xs text-gray-400">
          <div className="flex items-center gap-2"><div className="w-3 h-3 rounded bg-chitty-600" /> Normal</div>
          <div className="flex items-center gap-2"><div className="w-3 h-3 rounded bg-orange-500" /> Payment due</div>
          <div className="flex items-center gap-2"><div className="w-3 h-3 rounded bg-red-500" /> Negative balance</div>
          <div className="flex items-center gap-2"><div className="w-3 h-3 rounded bg-chitty-600 opacity-60" /> Low confidence (&lt;70%)</div>
        </div>
      </div>
    </div>
  );
}

function parseOblArray(val: string): string[] {
  if (!val) return [];
  try {
    const parsed = JSON.parse(val);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
