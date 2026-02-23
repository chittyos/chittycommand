import { useEffect, useState } from 'react';
import { api, type Obligation } from '../lib/api';
import { formatCurrency, formatDate, daysUntil, urgencyColor, statusBadgeColor } from '../lib/utils';

export function Bills() {
  const [obligations, setObligations] = useState<Obligation[]>([]);
  const [filter, setFilter] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params: Record<string, string> = {};
    if (filter) params.status = filter;
    api.getObligations(params).then(setObligations).catch((e) => setError(e.message));
  }, [filter]);

  const handleMarkPaid = async (id: string) => {
    await api.markPaid(id);
    setObligations((prev) => prev.map((o) => (o.id === id ? { ...o, status: 'paid', urgency_score: 0 } : o)));
  };

  if (error) return <p className="text-red-400">{error}</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Bills & Obligations</h1>
        <div className="flex gap-2">
          {['', 'pending', 'overdue', 'paid'].map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded text-sm ${filter === f ? 'bg-chitty-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}
            >
              {f || 'All'}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-[#161822] rounded-lg border border-gray-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-gray-400 text-xs uppercase">
              <th className="text-left px-4 py-3">Payee</th>
              <th className="text-left px-4 py-3">Category</th>
              <th className="text-right px-4 py-3">Amount</th>
              <th className="text-left px-4 py-3">Due Date</th>
              <th className="text-center px-4 py-3">Status</th>
              <th className="text-center px-4 py-3">Urgency</th>
              <th className="text-right px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {obligations.map((ob) => {
              const days = ob.due_date ? daysUntil(ob.due_date) : null;
              return (
                <tr key={ob.id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                  <td className="px-4 py-3 text-white">{ob.payee}</td>
                  <td className="px-4 py-3 text-gray-400">{ob.category}</td>
                  <td className="px-4 py-3 text-right text-white font-mono">{formatCurrency(ob.amount_due)}</td>
                  <td className="px-4 py-3">
                    {ob.due_date ? (
                      <span className={days !== null && days < 0 ? 'text-red-400' : days !== null && days <= 7 ? 'text-yellow-400' : 'text-gray-400'}>
                        {formatDate(ob.due_date)}
                        {days !== null && <span className="text-xs ml-1">({days > 0 ? `${days}d` : days === 0 ? 'today' : `${Math.abs(days)}d late`})</span>}
                      </span>
                    ) : (
                      <span className="text-gray-600">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`text-xs px-2 py-0.5 rounded ${statusBadgeColor(ob.status)} text-white`}>
                      {ob.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`font-mono text-sm ${urgencyColor(ob.urgency_score)}`}>
                      {ob.urgency_score ?? '—'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {ob.status !== 'paid' && (
                      <button
                        onClick={() => handleMarkPaid(ob.id)}
                        className="px-2 py-1 text-xs bg-green-700 text-white rounded hover:bg-green-600"
                      >
                        Mark Paid
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {obligations.length === 0 && (
          <p className="text-gray-500 text-sm py-8 text-center">No obligations found</p>
        )}
      </div>
    </div>
  );
}
