import { useEffect, useState } from 'react';
import { api, type Account } from '../lib/api';
import { Card } from '../components/ui/Card';
import { formatCurrency } from '../lib/utils';

export function Accounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getAccounts().then(setAccounts).catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="text-urgency-red">{error}</p>;

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

  const isDebtType = (type: string) => ['credit_card', 'store_credit', 'mortgage', 'loan'].includes(type);

  return (
    <div className="space-y-5 lg:space-y-6">
      <h1 className="text-lg lg:text-xl font-bold text-chrome-text">Accounts</h1>

      {Object.entries(grouped).map(([type, accts]) => (
        <div key={type}>
          <h2 className="text-chrome-muted text-sm uppercase tracking-wider font-medium mb-2">
            {typeLabels[type] || type}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 lg:gap-3">
            {accts.map((a) => (
              <Card key={a.id}>
                <div className="flex items-center justify-between">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-card-text truncate">{a.account_name}</p>
                    <p className="text-card-muted text-xs">{a.institution}</p>
                  </div>
                  <p className={`text-base lg:text-lg font-bold font-mono ${isDebtType(a.account_type) ? 'text-urgency-red' : 'text-urgency-green'}`}>
                    {formatCurrency(a.current_balance)}
                  </p>
                </div>
                {a.credit_limit && (
                  <div className="mt-3">
                    <div className="h-1.5 lg:h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-urgency-red rounded-full transition-all"
                        style={{ width: `${Math.min(100, (parseFloat(a.current_balance || '0') / parseFloat(a.credit_limit)) * 100)}%` }}
                      />
                    </div>
                    <p className="text-card-muted text-xs mt-1">
                      {formatCurrency(a.current_balance)} / {formatCurrency(a.credit_limit)}
                    </p>
                  </div>
                )}
              </Card>
            ))}
          </div>
        </div>
      ))}

      {accounts.length === 0 && (
        <p className="text-chrome-muted text-center py-8">No accounts configured</p>
      )}
    </div>
  );
}
