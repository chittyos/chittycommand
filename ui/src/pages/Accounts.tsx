import { useEffect, useState } from 'react';
import { api, type Account } from '../lib/api';
import { formatCurrency } from '../lib/utils';

export function Accounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getAccounts().then(setAccounts).catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="text-red-400">{error}</p>;

  const grouped = accounts.reduce<Record<string, Account[]>>((acc, a) => {
    const type = a.account_type;
    if (!acc[type]) acc[type] = [];
    acc[type].push(a);
    return acc;
  }, {});

  const typeLabels: Record<string, string> = {
    checking: 'Bank Accounts',
    savings: 'Savings',
    credit_card: 'Credit Cards',
    store_credit: 'Store Credit',
    mortgage: 'Mortgages',
    loan: 'Loans',
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Accounts</h1>

      {Object.entries(grouped).map(([type, accts]) => (
        <div key={type}>
          <h2 className="text-gray-400 text-sm uppercase tracking-wider mb-2">
            {typeLabels[type] || type}
          </h2>
          <div className="grid grid-cols-2 gap-3">
            {accts.map((a) => (
              <div key={a.id} className="bg-[#161822] rounded-lg border border-gray-800 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-white font-medium">{a.account_name}</p>
                    <p className="text-gray-500 text-xs">{a.institution}</p>
                  </div>
                  <p className={`text-lg font-bold font-mono ${
                    ['credit_card', 'store_credit', 'mortgage', 'loan'].includes(a.account_type)
                      ? 'text-red-400'
                      : 'text-green-400'
                  }`}>
                    {formatCurrency(a.current_balance)}
                  </p>
                </div>
                {a.credit_limit && (
                  <div className="mt-2">
                    <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-red-500 rounded-full"
                        style={{ width: `${Math.min(100, (parseFloat(a.current_balance || '0') / parseFloat(a.credit_limit)) * 100)}%` }}
                      />
                    </div>
                    <p className="text-gray-500 text-xs mt-1">
                      {formatCurrency(a.current_balance)} / {formatCurrency(a.credit_limit)}
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}

      {accounts.length === 0 && (
        <p className="text-gray-500 text-center py-8">No accounts configured</p>
      )}
    </div>
  );
}
