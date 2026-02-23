import { useEffect, useState, useCallback } from 'react';
import { api, type SyncStatus, type ServiceStatus } from '../lib/api';
import { formatDate } from '../lib/utils';
import { PlaidLink } from '../components/PlaidLink';

export function Settings() {
  const [syncStatuses, setSyncStatuses] = useState<SyncStatus[]>([]);
  const [serviceStatuses, setServiceStatuses] = useState<ServiceStatus[]>([]);
  const [triggering, setTriggering] = useState<string | null>(null);
  const [bridgeSyncing, setBridgeSyncing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [plaidMessage, setPlaidMessage] = useState<string | null>(null);

  useEffect(() => {
    api.getSyncStatus().then(setSyncStatuses).catch((e) => setError(e.message));
    api.getBridgeStatus().then((r) => setServiceStatuses(r.services)).catch(() => {});
  }, []);

  const handlePlaidSuccess = useCallback((itemId: string, count: number) => {
    setPlaidMessage(`Connected ${count} account${count !== 1 ? 's' : ''} (item: ${itemId.slice(0, 8)}...)`);
    // Refresh accounts list
    api.getBridgeStatus().then((r) => setServiceStatuses(r.services)).catch(() => {});
  }, []);

  const runBridgeSync = async (name: string, fn: () => Promise<any>) => {
    setBridgeSyncing(name);
    try {
      const result = await fn();
      setPlaidMessage(`${name}: ${JSON.stringify(result)}`);
    } catch (e: any) {
      setError(`${name} failed: ${e.message}`);
    } finally {
      setBridgeSyncing(null);
    }
  };

  const triggerSync = async (source: string) => {
    setTriggering(source);
    try {
      await api.triggerSync(source);
      const updated = await api.getSyncStatus();
      setSyncStatuses(updated);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setTriggering(null);
    }
  };

  const syncSources = [
    { key: 'mercury', label: 'Mercury Bank', method: 'API via ChittyConnect', schedule: 'Daily' },
    { key: 'wave', label: 'Wave Accounting', method: 'API via ChittyConnect', schedule: 'Daily' },
    { key: 'stripe', label: 'Stripe', method: 'API via ChittyConnect', schedule: 'Daily' },
    { key: 'turbotenant', label: 'TurboTenant', method: 'API via ChittyConnect', schedule: 'Daily' },
    { key: 'comed', label: 'ComEd', method: 'Email parse + scraper', schedule: 'Monthly' },
    { key: 'peoples_gas', label: 'Peoples Gas', method: 'Email parse + scraper', schedule: 'Monthly' },
    { key: 'xfinity', label: 'Xfinity', method: 'Email parse + scraper', schedule: 'Monthly' },
    { key: 'mr_cooper', label: 'Mr. Cooper Mortgage', method: 'PDF upload + scraper', schedule: 'Monthly' },
    { key: 'citi', label: 'Citi Credit Card', method: 'Email parse + PDF', schedule: 'Monthly' },
    { key: 'home_depot', label: 'Home Depot Credit', method: 'Email parse + manual', schedule: 'Monthly' },
    { key: 'lowes', label: "Lowe's Credit", method: 'Email parse + manual', schedule: 'Monthly' },
    { key: 'cook_county_tax', label: 'Cook County Property Tax', method: 'Scraper (by PIN)', schedule: 'Monthly' },
    { key: 'court_docket', label: 'Court Docket', method: 'Scraper', schedule: 'Daily' },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-white">Settings</h1>

      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-lg p-3 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Connection Status */}
      <div className="bg-[#161822] rounded-lg border border-gray-800 p-4">
        <h2 className="text-white font-semibold mb-3">Data Sources & Sync Status</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-500 border-b border-gray-800">
              <th className="text-left py-2">Source</th>
              <th className="text-left py-2">Method</th>
              <th className="text-left py-2">Schedule</th>
              <th className="text-left py-2">Last Sync</th>
              <th className="text-left py-2">Status</th>
              <th className="text-right py-2">Action</th>
            </tr>
          </thead>
          <tbody>
            {syncSources.map((src) => {
              const status = syncStatuses.find((s) => s.source === src.key);
              return (
                <tr key={src.key} className="border-b border-gray-800 last:border-0">
                  <td className="py-2 text-white">{src.label}</td>
                  <td className="py-2 text-gray-400">{src.method}</td>
                  <td className="py-2 text-gray-400">{src.schedule}</td>
                  <td className="py-2 text-gray-400">
                    {status?.completed_at ? formatDate(status.completed_at) : 'Never'}
                  </td>
                  <td className="py-2">
                    <SyncStatusBadge status={status?.status} />
                  </td>
                  <td className="py-2 text-right">
                    <button
                      onClick={() => triggerSync(src.key)}
                      disabled={triggering === src.key}
                      className="px-3 py-1 text-xs bg-chitty-600 text-white rounded hover:bg-chitty-700 disabled:opacity-50 transition-colors"
                    >
                      {triggering === src.key ? 'Syncing...' : 'Sync Now'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Bank Account Linking (Plaid) */}
      <div className="bg-[#161822] rounded-lg border border-gray-800 p-4">
        <h2 className="text-white font-semibold mb-3">Bank Account Linking</h2>
        <PlaidLink onSuccess={handlePlaidSuccess} />
        {plaidMessage && (
          <div className="mt-3 text-sm text-green-400 bg-green-900/20 rounded p-2 border border-green-800">
            {plaidMessage}
          </div>
        )}
      </div>

      {/* Bridge Sync Controls */}
      <div className="bg-[#161822] rounded-lg border border-gray-800 p-4">
        <h2 className="text-white font-semibold mb-3">Integration Sync</h2>
        <div className="grid grid-cols-2 gap-3">
          <BridgeSyncButton
            label="Plaid Transactions"
            syncing={bridgeSyncing === 'Plaid Transactions'}
            onClick={() => runBridgeSync('Plaid Transactions', api.syncPlaidTransactions)}
          />
          <BridgeSyncButton
            label="Plaid Balances"
            syncing={bridgeSyncing === 'Plaid Balances'}
            onClick={() => runBridgeSync('Plaid Balances', api.syncPlaidBalances)}
          />
          <BridgeSyncButton
            label="Finance Accounts"
            syncing={bridgeSyncing === 'Finance Accounts'}
            onClick={() => runBridgeSync('Finance Accounts', api.syncFinanceAccounts)}
          />
          <BridgeSyncButton
            label="Finance Transactions"
            syncing={bridgeSyncing === 'Finance Transactions'}
            onClick={() => runBridgeSync('Finance Transactions', api.syncFinanceTransactions)}
          />
          <BridgeSyncButton
            label="Ledger Documents"
            syncing={bridgeSyncing === 'Ledger Documents'}
            onClick={() => runBridgeSync('Ledger Documents', api.syncLedgerDocuments)}
          />
          <BridgeSyncButton
            label="Ledger Disputes"
            syncing={bridgeSyncing === 'Ledger Disputes'}
            onClick={() => runBridgeSync('Ledger Disputes', api.syncLedgerDisputes)}
          />
        </div>
      </div>

      {/* Service Connections (live status) */}
      <div className="bg-[#161822] rounded-lg border border-gray-800 p-4">
        <h2 className="text-white font-semibold mb-3">Service Connections</h2>
        <div className="grid grid-cols-2 gap-4">
          {serviceStatuses.length > 0 ? (
            serviceStatuses.map((svc) => (
              <ServiceCard
                key={svc.name}
                name={svc.name}
                url={`${svc.name.replace('chitty', '')}.chitty.cc`}
                description={svc.error || `Status: ${svc.status}`}
                connected={svc.status === 'ok'}
              />
            ))
          ) : (
            <>
              <ServiceCard name="ChittyAuth" url="auth.chitty.cc" description="Authentication & identity verification" connected />
              <ServiceCard name="ChittyConnect" url="connect.chitty.cc" description="API integrations & credential management" connected />
              <ServiceCard name="ChittyLedger" url="ledger.chitty.cc" description="Legal evidence & case management" connected />
              <ServiceCard name="ChittyFinance" url="finance.chitty.cc" description="Financial data aggregation" connected={false} />
              <ServiceCard name="ChittyCharge" url="charge.chitty.cc" description="Payment execution via Stripe" connected />
              <ServiceCard name="Plaid" url="plaid.com" description="Bank account linking & transactions" connected={false} />
            </>
          )}
        </div>
      </div>

      {/* Email Forwarding */}
      <div className="bg-[#161822] rounded-lg border border-gray-800 p-4">
        <h2 className="text-white font-semibold mb-3">Email Forwarding</h2>
        <p className="text-gray-400 text-sm mb-3">
          Forward bills and statements to the address below. ChittyCommand will parse them automatically.
        </p>
        <div className="flex items-center gap-3 bg-[#1c1f2e] rounded p-3 border border-gray-700">
          <code className="text-chitty-400 text-sm flex-1">bills@command.chitty.cc</code>
          <button
            onClick={() => navigator.clipboard.writeText('bills@command.chitty.cc')}
            className="px-3 py-1 text-xs bg-gray-700 text-white rounded hover:bg-gray-600 transition-colors"
          >
            Copy
          </button>
        </div>
        <p className="text-gray-600 text-xs mt-2">Phase 2: Cloudflare Email Workers integration</p>
      </div>
    </div>
  );
}

function SyncStatusBadge({ status }: { status?: string }) {
  if (!status) return <span className="text-xs px-1.5 py-0.5 rounded bg-gray-700 text-gray-400">Not synced</span>;
  const colors: Record<string, string> = {
    completed: 'bg-green-600 text-white',
    started: 'bg-yellow-600 text-white',
    error: 'bg-red-600 text-white',
  };
  return <span className={`text-xs px-1.5 py-0.5 rounded ${colors[status] || 'bg-gray-600 text-white'}`}>{status}</span>;
}

function BridgeSyncButton({ label, syncing, onClick }: { label: string; syncing: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={syncing}
      className="flex items-center justify-between px-3 py-2 text-sm bg-[#1c1f2e] border border-gray-700 rounded hover:border-chitty-600 disabled:opacity-50 transition-colors"
    >
      <span className="text-white">{label}</span>
      <span className={`text-xs px-2 py-0.5 rounded ${syncing ? 'bg-yellow-600 text-white' : 'bg-gray-700 text-gray-400'}`}>
        {syncing ? 'Syncing...' : 'Sync'}
      </span>
    </button>
  );
}

function ServiceCard({ name, url, description, connected }: { name: string; url: string; description: string; connected: boolean }) {
  return (
    <div className="p-3 rounded bg-[#1c1f2e] border border-gray-700">
      <div className="flex items-center justify-between">
        <h3 className="text-white text-sm font-medium">{name}</h3>
        <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-gray-500'}`} />
      </div>
      <p className="text-gray-500 text-xs mt-1">{url}</p>
      <p className="text-gray-400 text-xs mt-1">{description}</p>
    </div>
  );
}
