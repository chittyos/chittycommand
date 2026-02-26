import { useEffect, useState, useCallback } from 'react';
import { api, type SyncStatus, type ServiceStatus, type EmailConnection } from '../lib/api';
import { formatDate } from '../lib/utils';
import { PlaidLink } from '../components/PlaidLink';
import { Card } from '../components/ui/Card';
import { ActionButton } from '../components/ui/ActionButton';

export function Settings() {
  const [syncStatuses, setSyncStatuses] = useState<SyncStatus[]>([]);
  const [serviceStatuses, setServiceStatuses] = useState<ServiceStatus[]>([]);
  const [triggering, setTriggering] = useState<string | null>(null);
  const [bridgeSyncing, setBridgeSyncing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [plaidMessage, setPlaidMessage] = useState<string | null>(null);
  const [emailConnections, setEmailConnections] = useState<EmailConnection[]>([]);
  const [emailNamespace, setEmailNamespace] = useState<string | null>(null);
  const [namespaceClaim, setNamespaceClaim] = useState('');
  const [emailLoading, setEmailLoading] = useState(false);

  useEffect(() => {
    api.getSyncStatus().then(setSyncStatuses).catch((e) => setError(e.message));
    api.getBridgeStatus().then((r) => setServiceStatuses(r.services)).catch((e) => console.error('[Settings] bridge status failed:', e));
    api.getEmailConnections().then((r) => {
      setEmailConnections(r.connections);
      setEmailNamespace(r.namespace);
    }).catch((e) => console.error('[Settings] email connections failed:', e));
  }, []);

  const handlePlaidSuccess = useCallback((itemId: string, count: number) => {
    setPlaidMessage(`Connected ${count} account${count !== 1 ? 's' : ''} (item: ${itemId.slice(0, 8)}...)`);
    api.getBridgeStatus().then((r) => setServiceStatuses(r.services)).catch((e) => console.error('[Settings] bridge status refresh failed:', e));
  }, []);

  const runBridgeSync = async (name: string, fn: () => Promise<unknown>) => {
    setBridgeSyncing(name);
    try {
      const result = await fn();
      setPlaidMessage(`${name}: ${JSON.stringify(result)}`);
    } catch (e: unknown) {
      setError(`${name} failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
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
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Sync failed');
    } finally {
      setTriggering(null);
    }
  };

  const claimEmailNamespace = async () => {
    if (!namespaceClaim.trim()) return;
    setEmailLoading(true);
    try {
      const result = await api.claimNamespace(namespaceClaim.trim().toLowerCase());
      setEmailNamespace(result.namespace);
      setNamespaceClaim('');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to claim namespace');
    } finally {
      setEmailLoading(false);
    }
  };

  const connectGmail = async () => {
    setEmailLoading(true);
    try {
      const result = await api.initiateGmailOAuth();
      window.open(result.auth_url, '_blank', 'width=600,height=700');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Gmail OAuth failed');
    } finally {
      setEmailLoading(false);
    }
  };

  const disconnectEmail = async (id: string) => {
    try {
      await api.disconnectEmail(id);
      setEmailConnections((prev) => prev.map((c) =>
        c.id === id ? { ...c, status: 'disconnected' } : c
      ));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Disconnect failed');
    }
  };

  const syncEmail = async (id: string) => {
    try {
      await api.syncEmailConnection(id);
      setEmailConnections((prev) => prev.map((c) =>
        c.id === id ? { ...c, last_synced_at: new Date().toISOString() } : c
      ));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Sync failed');
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
      <h1 className="text-lg lg:text-xl font-bold text-chrome-text">Settings</h1>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-card p-3 text-urgency-red text-sm">
          {error}
        </div>
      )}

      {/* Data Sources & Sync Status */}
      <Card>
        <h2 className="text-card-text font-semibold mb-3">Data Sources & Sync Status</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-card-muted border-b border-card-border">
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
                  <tr key={src.key} className="border-b border-card-border last:border-0">
                    <td className="py-2 text-card-text">{src.label}</td>
                    <td className="py-2 text-card-muted">{src.method}</td>
                    <td className="py-2 text-card-muted">{src.schedule}</td>
                    <td className="py-2 text-card-muted">
                      {status?.completed_at ? formatDate(status.completed_at) : 'Never'}
                    </td>
                    <td className="py-2">
                      <SyncStatusBadge status={status?.status} />
                    </td>
                    <td className="py-2 text-right">
                      <ActionButton
                        label={triggering === src.key ? 'Syncing...' : 'Sync Now'}
                        onClick={() => triggerSync(src.key)}
                        loading={triggering === src.key}
                        className="px-3 py-1 text-xs"
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Bank Account Linking (Plaid) */}
      <Card>
        <h2 className="text-card-text font-semibold mb-3">Bank Account Linking</h2>
        <PlaidLink onSuccess={handlePlaidSuccess} />
        {plaidMessage && (
          <div className="mt-3 text-sm text-urgency-green bg-green-50 rounded-lg p-2 border border-green-200">
            {plaidMessage}
          </div>
        )}
      </Card>

      {/* Bridge Sync Controls */}
      <Card>
        <h2 className="text-card-text font-semibold mb-3">Integration Sync</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 lg:gap-3">
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
      </Card>

      {/* Service Connections (live status) */}
      <Card>
        <h2 className="text-card-text font-semibold mb-3">Service Connections</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 lg:gap-4">
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
      </Card>

      {/* Email Accounts */}
      <Card>
        <h2 className="text-card-text font-semibold mb-3">Email Accounts</h2>
        <p className="text-card-muted text-sm mb-4">
          Connect email accounts to automatically parse bills and statements.
        </p>

        {/* Namespace claim or display */}
        <div className="mb-4">
          <h3 className="text-card-text text-sm font-medium mb-2">Forwarding Address</h3>
          {emailNamespace ? (
            <div className="flex items-center gap-3 bg-card-hover rounded-lg p-3 border border-card-border">
              <code className="text-chitty-600 text-sm font-mono flex-1">{emailNamespace}</code>
              <button
                onClick={() => navigator.clipboard.writeText(emailNamespace)}
                className="px-3 py-1 text-xs bg-card-border text-card-text rounded-lg hover:bg-gray-200 transition-colors"
              >
                Copy
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="your-name"
                value={namespaceClaim}
                onChange={(e) => setNamespaceClaim(e.target.value)}
                className="flex-1 px-3 py-2 text-sm border border-card-border rounded-lg bg-white text-card-text focus:outline-none focus:ring-2 focus:ring-chitty-500"
              />
              <span className="text-card-muted text-sm">@chitty.cc</span>
              <ActionButton
                label={emailLoading ? 'Claiming...' : 'Claim'}
                onClick={claimEmailNamespace}
                loading={emailLoading}
                className="px-4 py-2 text-sm"
              />
            </div>
          )}
          <p className="text-card-muted text-xs mt-2">
            Forward bills to this address for automatic parsing via ChittyRouter.
          </p>
        </div>

        {/* Connect Gmail */}
        <div className="mb-4">
          <h3 className="text-card-text text-sm font-medium mb-2">Connect Gmail</h3>
          <ActionButton
            label={emailLoading ? 'Connecting...' : 'Connect Gmail Account'}
            onClick={connectGmail}
            loading={emailLoading}
            className="px-4 py-2 text-sm"
          />
          <p className="text-card-muted text-xs mt-2">
            Read-only access to scan for bills. Supports multiple accounts.
          </p>
        </div>

        {/* Connected accounts list */}
        {emailConnections.length > 0 && (
          <div>
            <h3 className="text-card-text text-sm font-medium mb-2">Connected Accounts</h3>
            <div className="space-y-2">
              {emailConnections.map((conn) => (
                <div key={conn.id} className="flex items-center justify-between p-3 rounded-lg bg-card-hover border border-card-border">
                  <div className="flex items-center gap-3">
                    <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 capitalize">
                      {conn.provider}
                    </span>
                    <div>
                      <p className="text-card-text text-sm font-medium">
                        {conn.display_name || conn.email_address}
                      </p>
                      {conn.display_name && (
                        <p className="text-card-muted text-xs">{conn.email_address}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      conn.status === 'active' ? 'bg-green-100 text-green-700' :
                      conn.status === 'error' ? 'bg-red-100 text-red-700' :
                      conn.status === 'disconnected' ? 'bg-gray-100 text-gray-500' :
                      'bg-amber-100 text-amber-700'
                    }`}>
                      {conn.status}
                    </span>
                    {conn.last_synced_at && (
                      <span className="text-card-muted text-xs">{formatDate(conn.last_synced_at)}</span>
                    )}
                    {conn.status === 'active' && conn.provider === 'gmail' && (
                      <button
                        onClick={() => syncEmail(conn.id)}
                        className="px-2 py-1 text-xs bg-card-border text-card-text rounded hover:bg-gray-200 transition-colors"
                      >
                        Sync
                      </button>
                    )}
                    {conn.status !== 'disconnected' && (
                      <button
                        onClick={() => disconnectEmail(conn.id)}
                        className="px-2 py-1 text-xs text-red-600 hover:bg-red-50 rounded transition-colors"
                      >
                        Disconnect
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function SyncStatusBadge({ status }: { status?: string }) {
  if (!status) return <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">Not synced</span>;
  const colors: Record<string, string> = {
    completed: 'bg-green-100 text-green-700',
    started: 'bg-amber-100 text-amber-700',
    error: 'bg-red-100 text-red-700',
  };
  return <span className={`text-xs px-2 py-0.5 rounded-full ${colors[status] || 'bg-gray-100 text-gray-600'}`}>{status}</span>;
}

function BridgeSyncButton({ label, syncing, onClick }: { label: string; syncing: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={syncing}
      className="flex items-center justify-between px-3 py-2 text-sm bg-card-hover border border-card-border rounded-lg hover:border-chitty-500 disabled:opacity-50 transition-colors"
    >
      <span className="text-card-text">{label}</span>
      <span className={`text-xs px-2 py-0.5 rounded-full ${syncing ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-600'}`}>
        {syncing ? 'Syncing...' : 'Sync'}
      </span>
    </button>
  );
}

function ServiceCard({ name, url, description, connected }: { name: string; url: string; description: string; connected: boolean }) {
  return (
    <div className="p-3 rounded-card bg-card-hover border border-card-border">
      <div className="flex items-center justify-between">
        <h3 className="text-card-text text-sm font-medium">{name}</h3>
        <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-gray-400'}`} />
      </div>
      <p className="text-card-muted text-xs mt-1">{url}</p>
      <p className="text-card-muted text-xs mt-1">{description}</p>
    </div>
  );
}
