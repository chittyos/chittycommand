import { useEffect, useState } from 'react';
import { api, type Account, type Transaction } from '../lib/api';
import { Card } from '../components/ui/Card';
import { ActionButton } from '../components/ui/ActionButton';
import { formatCurrency, formatDate, cn } from '../lib/utils';
import { useToast } from '../lib/toast';
import { ChevronDown, ChevronUp, ArrowDownLeft, ArrowUpRight } from 'lucide-react';

export function Accounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [txLoading, setTxLoading] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const toast = useToast();

  useEffect(() => {
    api.getAccounts().then(setAccounts).catch((e) => setError(e.message));
  }, []);

  const toggleExpand = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      setTransactions([]);
      return;
    }
    setExpandedId(id);
    setTxLoading(true);
    setTxError(null);
    try {
      const data = await api.getAccount(id);
      setTransactions(data.transactions || []);
    } catch (e: unknown) {
      setTransactions([]);
      setTxError(e instanceof Error ? e.message : 'Failed to load transactions');
    } finally {
      setTxLoading(false);
    }
  };

  const syncBalances = async () => {
    setSyncing(true);
    try {
      const result = await api.syncPlaidBalances();
      toast.success('Sync complete', `${result.accounts_updated} accounts updated`);
      const refreshed = await api.getAccounts();
      setAccounts(refreshed);
    } catch (e: unknown) {
      toast.error('Sync failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setSyncing(false);
    }
  };

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
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h1 className="text-lg lg:text-xl font-bold text-chrome-text">Accounts</h1>
        <ActionButton
          label={syncing ? 'Syncing...' : 'Sync Balances'}
          onClick={syncBalances}
          loading={syncing}
        />
      </div>

      {Object.entries(grouped).map(([type, accts]) => (
        <div key={type}>
          <h2 className="text-chrome-muted text-sm uppercase tracking-wider font-medium mb-2">
            {typeLabels[type] || type}
          </h2>
          <div className="space-y-2">
            {accts.map((a) => (
              <div key={a.id}>
                <Card onClick={() => toggleExpand(a.id)}>
                  <div className="flex items-center justify-between">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-card-text truncate">{a.account_name}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <p className="text-card-muted text-xs">{a.institution}</p>
                        {a.last_synced_at && (
                          <span className="text-card-muted text-[10px]">Synced {formatDate(a.last_synced_at)}</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <p className={cn('text-base lg:text-lg font-bold font-mono', isDebtType(a.account_type) ? 'text-urgency-red' : 'text-urgency-green')}>
                        {formatCurrency(a.current_balance)}
                      </p>
                      {expandedId === a.id ? <ChevronUp size={16} className="text-card-muted" /> : <ChevronDown size={16} className="text-card-muted" />}
                    </div>
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
                        {a.interest_rate && <span className="ml-2">{a.interest_rate}% APR</span>}
                      </p>
                    </div>
                  )}
                </Card>

                {/* Expanded transaction list */}
                {expandedId === a.id && (
                  <div className="ml-4 border-l-2 border-card-border pl-4 mt-1 mb-2">
                    {txLoading ? (
                      <p className="text-card-muted text-sm py-4">Loading transactions...</p>
                    ) : txError ? (
                      <p className="text-urgency-red text-sm py-4">Failed to load transactions: {txError}</p>
                    ) : transactions.length === 0 ? (
                      <p className="text-card-muted text-sm py-4">No recent transactions</p>
                    ) : (
                      <div className="space-y-1">
                        <p className="text-xs text-card-muted font-medium mb-2">Recent Transactions</p>
                        {transactions.slice(0, 20).map((tx) => (
                          <div key={tx.id} className="flex items-center justify-between py-1.5 border-b border-card-border/30 last:border-0">
                            <div className="flex items-center gap-2 min-w-0 flex-1">
                              {tx.direction === 'credit' ? (
                                <ArrowDownLeft size={14} className="text-urgency-green shrink-0" />
                              ) : (
                                <ArrowUpRight size={14} className="text-urgency-red shrink-0" />
                              )}
                              <span className="text-sm text-card-text truncate">{tx.description}</span>
                            </div>
                            <div className="flex items-center gap-3 shrink-0">
                              <span className={cn('text-sm font-mono', tx.direction === 'credit' ? 'text-urgency-green' : 'text-card-text')}>
                                {tx.direction === 'credit' ? '+' : '-'}{formatCurrency(tx.amount)}
                              </span>
                              <span className="text-xs text-card-muted">{formatDate(tx.tx_date)}</span>
                            </div>
                          </div>
                        ))}
                        {transactions.length > 20 && (
                          <p className="text-xs text-card-muted text-center py-2">
                            Showing 20 of {transactions.length} transactions
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
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
