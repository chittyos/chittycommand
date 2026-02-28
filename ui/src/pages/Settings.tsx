import { useEffect, useState, useCallback } from 'react';
import { api, type SyncStatus, type ServiceStatus, type EmailConnection, type TokenOverview } from '../lib/api';
import { formatDate } from '../lib/utils';
import { PlaidLink } from '../components/PlaidLink';
import { Card } from '../components/ui/Card';
import { ActionButton } from '../components/ui/ActionButton';
import {
  Database, Link2, RefreshCw, Shield, Mail,
  CheckCircle2, XCircle, AlertCircle, Clock,
  Copy, ExternalLink,
} from 'lucide-react';

const TABS = [
  { key: 'sources', label: 'Data Sources', icon: Database },
  { key: 'integrations', label: 'Integrations', icon: Link2 },
  { key: 'services', label: 'Services', icon: RefreshCw },
  { key: 'auth', label: 'Auth', icon: Shield },
  { key: 'email', label: 'Email', icon: Mail },
] as const;

type TabKey = (typeof TABS)[number]['key'];

export function Settings() {
  const [activeTab, setActiveTab] = useState<TabKey>('sources');
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
  const [tokenOverview, setTokenOverview] = useState<TokenOverview | null>(null);
  const [tokenAdminInput, setTokenAdminInput] = useState('');
  const [tokenValidateInput, setTokenValidateInput] = useState('');
  const [tokenProvisionPayload, setTokenProvisionPayload] = useState('{"scope":["mcp:read"],"name":"chittycommand-ui"}');
  const [tokenRevokePayload, setTokenRevokePayload] = useState('{"token":""}');
  const [tokenActionLoading, setTokenActionLoading] = useState<string | null>(null);
  const [tokenActionResult, setTokenActionResult] = useState<string | null>(null);
  const [latestLegacyToken, setLatestLegacyToken] = useState<{ key: string; token: string } | null>(null);

  useEffect(() => {
    api.getSyncStatus().then(setSyncStatuses).catch((e) => setError(e.message));
    api.getBridgeStatus().then((r) => setServiceStatuses(r.services)).catch((e) => console.error('[Settings] bridge status failed:', e));
    api.getEmailConnections().then((r) => {
      setEmailConnections(r.connections);
      setEmailNamespace(r.namespace);
    }).catch((e) => console.error('[Settings] email connections failed:', e));
    api.getTokenOverview().then(setTokenOverview).catch((e) => console.error('[Settings] token overview failed:', e));
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

  const parseJsonInput = (value: string, label: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setError(`${label} must be a JSON object`);
        return null;
      }
      return parsed as Record<string, unknown>;
    } catch {
      setError(`${label} is invalid JSON`);
      return null;
    }
  };

  const refreshTokenOverview = async () => {
    try {
      const overview = await api.getTokenOverview();
      setTokenOverview(overview);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to refresh token overview');
    }
  };

  const rotateLegacyToken = async (key: 'mcp:service_token' | 'bridge:service_token' | 'scrape:service_token') => {
    setTokenActionLoading(key);
    setTokenActionResult(null);
    try {
      const result = await api.rotateLegacyToken(key);
      setLatestLegacyToken({ key: result.key, token: result.token });
      setTokenActionResult(`Rotated ${result.key} at ${formatDate(result.rotated_at)}`);
      await refreshTokenOverview();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Token rotation failed');
    } finally {
      setTokenActionLoading(null);
    }
  };

  const provisionChittyAuthToken = async () => {
    const payload = parseJsonInput(tokenProvisionPayload, 'Provision payload');
    if (!payload) return;
    setTokenActionLoading('provision');
    setTokenActionResult(null);
    try {
      const result = await api.provisionChittyAuthToken(tokenAdminInput.trim(), payload);
      setTokenActionResult(JSON.stringify(result, null, 2));
      await refreshTokenOverview();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Token provision failed');
    } finally {
      setTokenActionLoading(null);
    }
  };

  const validateChittyAuthToken = async () => {
    if (!tokenValidateInput.trim()) {
      setError('Token to validate is required');
      return;
    }
    setTokenActionLoading('validate');
    setTokenActionResult(null);
    try {
      const result = await api.validateChittyAuthToken(tokenValidateInput.trim());
      setTokenActionResult(JSON.stringify(result, null, 2));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Token validation failed');
    } finally {
      setTokenActionLoading(null);
    }
  };

  const revokeChittyAuthToken = async () => {
    const payload = parseJsonInput(tokenRevokePayload, 'Revoke payload');
    if (!payload) return;
    setTokenActionLoading('revoke');
    setTokenActionResult(null);
    try {
      const result = await api.revokeChittyAuthToken(tokenAdminInput.trim(), payload);
      setTokenActionResult(JSON.stringify(result, null, 2));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Token revoke failed');
    } finally {
      setTokenActionLoading(null);
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
    <div className="space-y-5 animate-fade-in-up">
      <h1 className="font-display text-xl lg:text-2xl font-bold text-chrome-text tracking-tight">Settings</h1>

      {error && (
        <div className="flex items-center gap-2 bg-urgency-red/10 border border-urgency-red/20 rounded-xl p-3 text-urgency-red text-sm animate-fade-in">
          <AlertCircle size={16} className="shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-urgency-red/60 hover:text-urgency-red transition-colors">&times;</button>
        </div>
      )}

      {/* Tab navigation */}
      <div className="flex items-center gap-1 overflow-x-auto scrollbar-hide bg-chrome-surface/60 backdrop-blur-sm rounded-2xl p-1 border border-chrome-border">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200 shrink-0 ${
              activeTab === tab.key
                ? 'bg-chitty-600 text-white shadow-glow-brand'
                : 'text-chrome-muted hover:text-chrome-text hover:bg-chrome-border/40'
            }`}
          >
            <tab.icon size={15} />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="animate-fade-in" key={activeTab}>
        {activeTab === 'sources' && (
          <Card>
            <h2 className="font-display text-card-text font-semibold mb-4 text-base">Data Sources & Sync Status</h2>
            <div className="overflow-x-auto -mx-4 px-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-card-muted border-b border-card-border">
                    <th className="text-left py-2.5 text-[10px] uppercase tracking-widest font-semibold">Source</th>
                    <th className="text-left py-2.5 text-[10px] uppercase tracking-widest font-semibold">Method</th>
                    <th className="text-left py-2.5 text-[10px] uppercase tracking-widest font-semibold hidden sm:table-cell">Schedule</th>
                    <th className="text-left py-2.5 text-[10px] uppercase tracking-widest font-semibold">Last Sync</th>
                    <th className="text-left py-2.5 text-[10px] uppercase tracking-widest font-semibold">Status</th>
                    <th className="text-right py-2.5 text-[10px] uppercase tracking-widest font-semibold">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {syncSources.map((src, i) => {
                    const status = syncStatuses.find((s) => s.source === src.key);
                    return (
                      <tr key={src.key} className={`border-b border-card-border/50 last:border-0 animate-fade-in-up stagger-${Math.min(i + 1, 6)}`}>
                        <td className="py-2.5 text-card-text font-medium">{src.label}</td>
                        <td className="py-2.5 text-card-muted text-xs">{src.method}</td>
                        <td className="py-2.5 text-card-muted text-xs hidden sm:table-cell">{src.schedule}</td>
                        <td className="py-2.5 text-card-muted text-xs font-mono">
                          {status?.completed_at ? formatDate(status.completed_at) : <span className="opacity-40">Never</span>}
                        </td>
                        <td className="py-2.5">
                          <SyncStatusBadge status={status?.status} />
                        </td>
                        <td className="py-2.5 text-right">
                          <ActionButton
                            label={triggering === src.key ? 'Syncing...' : 'Sync'}
                            onClick={() => triggerSync(src.key)}
                            loading={triggering === src.key}
                            variant="secondary"
                            className="px-3 py-1.5 text-xs"
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {activeTab === 'integrations' && (
          <div className="space-y-4">
            <Card>
              <h2 className="font-display text-card-text font-semibold mb-3 text-base">Bank Account Linking</h2>
              <p className="text-card-muted text-sm mb-4">Connect bank accounts via Plaid for automatic transaction syncing.</p>
              <PlaidLink onSuccess={handlePlaidSuccess} />
              {plaidMessage && (
                <div className="mt-3 flex items-center gap-2 text-sm text-urgency-green bg-urgency-green/5 rounded-xl p-3 border border-urgency-green/20 animate-fade-in">
                  <CheckCircle2 size={16} className="shrink-0" />
                  {plaidMessage}
                </div>
              )}
            </Card>

            <Card>
              <h2 className="font-display text-card-text font-semibold mb-3 text-base">Bridge Sync Controls</h2>
              <p className="text-card-muted text-sm mb-4">Manually trigger sync operations between services.</p>
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
          </div>
        )}

        {activeTab === 'services' && (
          <Card>
            <h2 className="font-display text-card-text font-semibold mb-4 text-base">Service Connections</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {serviceStatuses.length > 0 ? (
                serviceStatuses.map((svc, i) => (
                  <ServiceCard
                    key={svc.name}
                    name={svc.name}
                    url={`${svc.name.replace('chitty', '')}.chitty.cc`}
                    description={svc.error || `Status: ${svc.status}`}
                    connected={svc.status === 'ok'}
                    index={i}
                  />
                ))
              ) : (
                <div className="col-span-full flex items-center justify-center py-12 text-card-muted text-sm">
                  <RefreshCw size={16} className="animate-spin mr-2" />
                  Loading service status...
                </div>
              )}
            </div>
          </Card>
        )}

        {activeTab === 'auth' && (
          <Card>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-card-text font-semibold text-base">Auth Management</h2>
              <ActionButton
                label="Refresh"
                onClick={refreshTokenOverview}
                variant="secondary"
                className="px-3 py-1.5 text-xs"
              />
            </div>

            <p className="text-card-muted text-sm mb-5">
              ChittyAuth as the token control plane, with local legacy tokens for compatibility.
            </p>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
              <div className="rounded-xl border border-card-border p-4 bg-card-hover">
                <div className="flex items-center gap-2 mb-2">
                  <Shield size={14} className="text-chitty-500" />
                  <h3 className="text-card-text text-sm font-semibold">ChittyAuth Status</h3>
                </div>
                <p className="text-card-muted text-xs font-mono">
                  {tokenOverview?.chittyauth.base_url || 'https://auth.chitty.cc'}
                </p>
                <div className="flex items-center gap-2 mt-2">
                  <span className={`w-2 h-2 rounded-full ${tokenOverview?.chittyauth.status === 'ok' ? 'bg-urgency-green status-dot-ok' : 'bg-chrome-muted'}`} />
                  <p className="text-card-muted text-xs">
                    {tokenOverview?.chittyauth.status || 'unknown'}
                    {tokenOverview?.chittyauth.health_code ? ` (${tokenOverview.chittyauth.health_code})` : ''}
                  </p>
                </div>
              </div>
              <div className="rounded-xl border border-card-border p-4 bg-card-hover">
                <h3 className="text-card-text text-sm font-semibold mb-3">Legacy Tokens</h3>
                <div className="space-y-2.5">
                  {(tokenOverview?.legacy || []).map((item) => (
                    <div key={item.key} className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-card-text text-xs font-medium font-mono truncate">{item.key}</p>
                        <p className="text-card-muted text-[10px] font-mono truncate">{item.configured ? item.preview : 'not configured'}</p>
                      </div>
                      <ActionButton
                        label={tokenActionLoading === item.key ? 'Rotating...' : 'Rotate'}
                        onClick={() => rotateLegacyToken(item.key)}
                        loading={tokenActionLoading === item.key}
                        variant="secondary"
                        className="px-2.5 py-1 text-xs shrink-0"
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="space-y-5">
              <InputSection label="ChittyAuth Admin Token">
                <input
                  type="password"
                  value={tokenAdminInput}
                  onChange={(e) => setTokenAdminInput(e.target.value)}
                  placeholder="Bearer token for provision/revoke"
                  className="input-field"
                />
              </InputSection>

              <InputSection label="Provision Payload (JSON)">
                <textarea
                  value={tokenProvisionPayload}
                  onChange={(e) => setTokenProvisionPayload(e.target.value)}
                  rows={3}
                  className="input-field font-mono text-xs"
                />
                <ActionButton
                  label={tokenActionLoading === 'provision' ? 'Provisioning...' : 'Provision via ChittyAuth'}
                  onClick={provisionChittyAuthToken}
                  loading={tokenActionLoading === 'provision'}
                  className="mt-2"
                />
              </InputSection>

              <InputSection label="Validate Token">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={tokenValidateInput}
                    onChange={(e) => setTokenValidateInput(e.target.value)}
                    placeholder="Token to validate"
                    className="input-field flex-1"
                  />
                  <ActionButton
                    label={tokenActionLoading === 'validate' ? 'Validating...' : 'Validate'}
                    onClick={validateChittyAuthToken}
                    loading={tokenActionLoading === 'validate'}
                    variant="secondary"
                  />
                </div>
              </InputSection>

              <InputSection label="Revoke Payload (JSON)">
                <textarea
                  value={tokenRevokePayload}
                  onChange={(e) => setTokenRevokePayload(e.target.value)}
                  rows={3}
                  className="input-field font-mono text-xs"
                />
                <ActionButton
                  label={tokenActionLoading === 'revoke' ? 'Revoking...' : 'Revoke via ChittyAuth'}
                  onClick={revokeChittyAuthToken}
                  loading={tokenActionLoading === 'revoke'}
                  variant="danger"
                  className="mt-2"
                />
              </InputSection>

              {latestLegacyToken && (
                <div className="rounded-xl border border-urgency-green/20 bg-urgency-green/5 p-4 animate-fade-in">
                  <p className="text-urgency-green text-xs font-semibold mb-2">Latest rotated token: {latestLegacyToken.key}</p>
                  <div className="flex items-center gap-2">
                    <code className="text-xs font-mono text-card-text break-all flex-1 bg-white/60 rounded-lg px-3 py-2">{latestLegacyToken.token}</code>
                    <button
                      onClick={() => navigator.clipboard.writeText(latestLegacyToken.token)}
                      className="p-2 rounded-lg bg-urgency-green/10 text-urgency-green hover:bg-urgency-green/20 transition-colors shrink-0"
                      title="Copy token"
                    >
                      <Copy size={14} />
                    </button>
                  </div>
                </div>
              )}

              {tokenActionResult && (
                <div className="rounded-xl border border-card-border bg-card-hover p-4 animate-fade-in">
                  <p className="text-card-text text-xs font-semibold mb-2">Last auth operation result</p>
                  <pre className="text-xs text-card-muted whitespace-pre-wrap break-all font-mono bg-white/40 rounded-lg p-3">{tokenActionResult}</pre>
                </div>
              )}
            </div>
          </Card>
        )}

        {activeTab === 'email' && (
          <Card>
            <h2 className="font-display text-card-text font-semibold mb-3 text-base">Email Accounts</h2>
            <p className="text-card-muted text-sm mb-5">
              Connect email accounts to automatically parse bills and statements.
            </p>

            {/* Namespace claim or display */}
            <div className="mb-6">
              <h3 className="text-card-text text-sm font-semibold mb-2">Forwarding Address</h3>
              {emailNamespace ? (
                <div className="flex items-center gap-3 bg-card-hover rounded-xl p-3 border border-card-border">
                  <code className="text-chitty-500 text-sm font-mono font-semibold flex-1">{emailNamespace}</code>
                  <button
                    onClick={() => navigator.clipboard.writeText(emailNamespace)}
                    className="p-2 rounded-lg bg-chitty-50 text-chitty-600 hover:bg-chitty-100 transition-colors"
                    title="Copy address"
                  >
                    <Copy size={14} />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder="your-name"
                    value={namespaceClaim}
                    onChange={(e) => setNamespaceClaim(e.target.value)}
                    className="input-field flex-1"
                  />
                  <span className="text-card-muted text-sm font-mono">@chitty.cc</span>
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
            <div className="mb-6">
              <h3 className="text-card-text text-sm font-semibold mb-2">Connect Gmail</h3>
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
                <h3 className="text-card-text text-sm font-semibold mb-3">Connected Accounts</h3>
                <div className="space-y-2">
                  {emailConnections.map((conn) => (
                    <div key={conn.id} className="flex items-center justify-between p-3 rounded-xl bg-card-hover border border-card-border transition-all duration-200 hover:shadow-card">
                      <div className="flex items-center gap-3">
                        <span className="text-[10px] px-2 py-1 rounded-lg bg-chitty-50 text-chitty-600 uppercase tracking-wider font-semibold">
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
                        <EmailStatusBadge status={conn.status} />
                        {conn.last_synced_at && (
                          <span className="text-card-muted text-xs font-mono hidden sm:inline">{formatDate(conn.last_synced_at)}</span>
                        )}
                        {conn.status === 'active' && conn.provider === 'gmail' && (
                          <ActionButton
                            label="Sync"
                            onClick={() => syncEmail(conn.id)}
                            variant="secondary"
                            className="px-2.5 py-1 text-xs"
                          />
                        )}
                        {conn.status !== 'disconnected' && (
                          <ActionButton
                            label="Disconnect"
                            onClick={() => disconnectEmail(conn.id)}
                            variant="danger"
                            className="px-2.5 py-1 text-xs"
                          />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}

function InputSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-card-text text-sm font-semibold mb-1.5">{label}</label>
      {children}
    </div>
  );
}

function SyncStatusBadge({ status }: { status?: string }) {
  if (!status) return (
    <span className="inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded-lg bg-gray-50 text-gray-400 font-medium uppercase tracking-wider">
      <Clock size={10} />
      Pending
    </span>
  );
  const styles: Record<string, { bg: string; icon: typeof CheckCircle2 }> = {
    completed: { bg: 'bg-urgency-green/10 text-urgency-green', icon: CheckCircle2 },
    started: { bg: 'bg-urgency-amber/10 text-urgency-amber', icon: RefreshCw },
    error: { bg: 'bg-urgency-red/10 text-urgency-red', icon: XCircle },
  };
  const style = styles[status] || { bg: 'bg-gray-50 text-gray-400', icon: Clock };
  const Icon = style.icon;
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded-lg font-semibold uppercase tracking-wider ${style.bg}`}>
      <Icon size={10} className={status === 'started' ? 'animate-spin' : ''} />
      {status}
    </span>
  );
}

function EmailStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    active: 'bg-urgency-green/10 text-urgency-green',
    error: 'bg-urgency-red/10 text-urgency-red',
    disconnected: 'bg-gray-100 text-gray-400',
  };
  return (
    <span className={`text-[10px] px-2 py-1 rounded-lg font-semibold uppercase tracking-wider ${styles[status] || 'bg-urgency-amber/10 text-urgency-amber'}`}>
      {status}
    </span>
  );
}

function BridgeSyncButton({ label, syncing, onClick }: { label: string; syncing: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={syncing}
      className="flex items-center justify-between px-4 py-3 text-sm bg-card-hover border border-card-border rounded-xl hover:border-chitty-400/40 hover:shadow-glow-brand disabled:opacity-50 transition-all duration-200 group"
    >
      <span className="text-card-text font-medium group-hover:text-chitty-600 transition-colors">{label}</span>
      <span className={`text-[10px] px-2.5 py-1 rounded-lg font-semibold uppercase tracking-wider ${syncing ? 'bg-urgency-amber/10 text-urgency-amber' : 'bg-card-border/50 text-card-muted'}`}>
        {syncing ? (
          <span className="flex items-center gap-1">
            <RefreshCw size={10} className="animate-spin" />
            Syncing
          </span>
        ) : 'Sync'}
      </span>
    </button>
  );
}

function ServiceCard({ name, url, description, connected, index }: { name: string; url: string; description: string; connected: boolean; index: number }) {
  return (
    <div className={`p-4 rounded-xl bg-card-hover border border-card-border transition-all duration-200 hover:shadow-card hover:-translate-y-0.5 animate-fade-in-up stagger-${Math.min(index + 1, 6)}`}>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-card-text text-sm font-semibold">{name}</h3>
        <span className={`w-2.5 h-2.5 rounded-full transition-shadow ${connected ? 'bg-urgency-green status-dot-ok' : 'bg-gray-300'}`} />
      </div>
      <div className="flex items-center gap-1 text-card-muted text-xs mb-1">
        <ExternalLink size={10} />
        <span className="font-mono">{url}</span>
      </div>
      <p className="text-card-muted text-xs">{description}</p>
    </div>
  );
}
