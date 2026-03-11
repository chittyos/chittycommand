import { useEffect, useState, useCallback, useRef } from 'react';
import { api, type Dispute, type Correspondence, type LegalDeadline } from '../lib/api';
import { Card } from '../components/ui/Card';
import { ActionButton } from '../components/ui/ActionButton';
import { formatCurrency, formatDate, daysUntil } from '../lib/utils';
import { useToast } from '../lib/toast';
import { useSearchParams } from 'react-router-dom';

const DISPUTE_STAGES = [
  'filed',
  'response_pending',
  'evidence_gathering',
  'in_review',
  'negotiation',
  'resolved',
] as const;

type DisputeStage = typeof DISPUTE_STAGES[number];
type CorrespondenceDirection = 'inbound' | 'outbound';
type CorrespondenceChannel = 'email' | 'phone' | 'mail' | 'portal' | 'in_person';

const STAGE_LABELS: Record<DisputeStage, string> = {
  filed: 'Filed',
  response_pending: 'Response Pending',
  evidence_gathering: 'Evidence',
  in_review: 'In Review',
  negotiation: 'Negotiation',
  resolved: 'Resolved',
};

function normalizeStage(dispute: Dispute): DisputeStage {
  if (dispute.stage && DISPUTE_STAGES.includes(dispute.stage as DisputeStage)) {
    return dispute.stage as DisputeStage;
  }
  if (dispute.status === 'resolved' || dispute.status === 'dismissed') return 'resolved';
  return 'filed';
}

function getNextStage(current: DisputeStage): DisputeStage {
  const idx = DISPUTE_STAGES.indexOf(current);
  if (idx < 0 || idx >= DISPUTE_STAGES.length - 1) return current;
  return DISPUTE_STAGES[idx + 1];
}

/** Urgency color classes for countdown badges: red <=3d, amber <=7d, green otherwise */
function countdownClasses(days: number): { bg: string; text: string } {
  if (days < 0) return { bg: 'bg-red-600', text: 'text-white' };
  if (days <= 3) return { bg: 'bg-red-100', text: 'text-red-700' };
  if (days <= 7) return { bg: 'bg-amber-100', text: 'text-amber-700' };
  return { bg: 'bg-green-100', text: 'text-green-700' };
}

function countdownLabel(days: number): string {
  if (days < 0) return `${Math.abs(days)}d ago`;
  if (days === 0) return 'TODAY';
  return `${days}d`;
}

export function Disputes() {
  const [searchParams] = useSearchParams();
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [correspondenceList, setCorrespondenceList] = useState<Correspondence[]>([]);
  const [documentList, setDocumentList] = useState<{ id: string; filename: string | null; doc_type: string; created_at: string }[]>([]);
  const [deadlineList, setDeadlineList] = useState<LegalDeadline[]>([]);
  const [activePanel, setActivePanel] = useState<'correspondence' | 'documents' | 'deadlines' | null>(null);
  const [newCorrespondence, setNewCorrespondence] = useState<{
    direction: CorrespondenceDirection;
    channel: CorrespondenceChannel;
    subject: string;
    content: string;
  }>({ direction: 'outbound', channel: 'email', subject: '', content: '' });
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [advancingId, setAdvancingId] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [uploadingDoc, setUploadingDoc] = useState(false);
  const [docFile, setDocFile] = useState<File | null>(null);
  const [newDispute, setNewDispute] = useState({
    title: '',
    counterparty: '',
    dispute_type: 'billing_error',
    amount_at_stake: '',
    priority: '5',
    description: '',
    next_action: '',
    next_action_date: '',
  });
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<{ pushed: number; reconciled: number; duration_ms: number; at: Date } | null>(null);
  const [showSyncStatus, setShowSyncStatus] = useState(false);
  const toast = useToast();
  const autoExpandedRef = useRef<string | null>(null);

  const reload = useCallback(() => {
    api.getDisputes('open').then(setDisputes).catch((e) => setError(e.message));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    const expandId = searchParams.get('expand');
    if (!expandId || autoExpandedRef.current === expandId) return;
    if (!disputes.some((d) => d.id === expandId)) return;

    autoExpandedRef.current = expandId;
    setExpandedId(expandId);
    setActivePanel('correspondence');
    setPanelError(null);
    setDocFile(null);

    api.getDispute(expandId)
      .then((detail) => setCorrespondenceList(detail.correspondence || []))
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : 'Failed to load';
        setPanelError(`Unable to load correspondence: ${msg}`);
        setCorrespondenceList([]);
      });
  }, [disputes, searchParams]);

  const togglePanel = async (disputeId: string, panel: 'correspondence' | 'documents' | 'deadlines') => {
    if (expandedId === disputeId && activePanel === panel) {
      setExpandedId(null);
      setActivePanel(null);
      setPanelError(null);
      setDocFile(null);
      return;
    }
    setExpandedId(disputeId);
    setActivePanel(panel);
    setPanelError(null);
    setDocFile(null);
    try {
      const detail = await api.getDispute(disputeId);
      if (panel === 'correspondence') setCorrespondenceList(detail.correspondence || []);
      else if (panel === 'documents') setDocumentList(detail.documents || []);
      else setDeadlineList(await api.getDisputeDeadlines(disputeId));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to load';
      setPanelError(`Unable to load ${panel}: ${msg}`);
      if (panel === 'correspondence') setCorrespondenceList([]);
      else if (panel === 'documents') setDocumentList([]);
      else setDeadlineList([]);
    }
  };

  const submitCreateDispute = async () => {
    if (!newDispute.title.trim() || !newDispute.counterparty.trim() || !newDispute.dispute_type.trim()) return;
    setCreating(true);
    try {
      await api.createDispute({
        title: newDispute.title.trim(),
        counterparty: newDispute.counterparty.trim(),
        dispute_type: newDispute.dispute_type.trim(),
        amount_at_stake: newDispute.amount_at_stake ? parseFloat(newDispute.amount_at_stake) : undefined,
        priority: parseInt(newDispute.priority, 10) || 5,
        description: newDispute.description.trim() || undefined,
        next_action: newDispute.next_action.trim() || undefined,
        next_action_date: newDispute.next_action_date || undefined,
      });
      toast.success('Dispute created', newDispute.title, { durationMs: 2200 });
      setShowCreateForm(false);
      setNewDispute({
        title: '',
        counterparty: '',
        dispute_type: 'billing_error',
        amount_at_stake: '',
        priority: '5',
        description: '',
        next_action: '',
        next_action_date: '',
      });
      reload();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to create dispute';
      setError(msg);
      toast.error('Could not create dispute', msg);
    } finally {
      setCreating(false);
    }
  };

  const submitCorrespondence = async () => {
    if (!expandedId || !newCorrespondence.subject.trim()) return;
    setSaving(true);
    try {
      await api.addCorrespondence(expandedId, newCorrespondence);
      setNewCorrespondence({ direction: 'outbound', channel: 'email', subject: '', content: '' });
      const detail = await api.getDispute(expandedId);
      setCorrespondenceList(detail.correspondence || []);
      toast.success('Correspondence saved', 'Entry added to dispute timeline.', { durationMs: 2000 });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to add correspondence';
      setError(msg);
      toast.error('Could not save correspondence', msg);
    } finally {
      setSaving(false);
    }
  };

  const advanceStage = async (dispute: Dispute) => {
    const current = normalizeStage(dispute);
    const next = getNextStage(current);
    if (next === current) return;

    setAdvancingId(dispute.id);
    try {
      await api.updateDispute(dispute.id, {
        stage: next,
        ...(next === 'resolved' ? { status: 'resolved' } : {}),
      });
      toast.success('Stage advanced', `${STAGE_LABELS[current]} → ${STAGE_LABELS[next]}`, { durationMs: 2200 });
      reload();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to advance stage';
      toast.error('Could not advance stage', msg);
    } finally {
      setAdvancingId(null);
    }
  };

  const uploadFromDisputeContext = async () => {
    if (!expandedId || !docFile) return;
    setUploadingDoc(true);
    setPanelError(null);
    try {
      await api.uploadDocument(docFile, { linked_dispute_id: expandedId });
      const detail = await api.getDispute(expandedId);
      setDocumentList(detail.documents || []);
      toast.success('Document uploaded', docFile.name, { durationMs: 2200 });
      setDocFile(null);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Upload failed';
      setPanelError(msg);
      toast.error('Could not upload document', msg);
    } finally {
      setUploadingDoc(false);
    }
  };

  const priorityUrgency = (p: number): 'red' | 'amber' | 'green' => {
    if (p <= 1) return 'red';
    if (p <= 3) return 'amber';
    return 'green';
  };

  const syncNotion = async () => {
    setSyncing(true);
    try {
      const result = await api.syncDisputesNotion('both');
      const syncResult = { pushed: result.pushed, reconciled: result.reconciled, duration_ms: result.duration_ms, at: new Date() };
      setLastSync(syncResult);
      setShowSyncStatus(true);
      toast.success('Notion sync complete', `Pushed ${result.pushed}, reconciled ${result.reconciled} in ${result.duration_ms}ms`, { durationMs: 3000 });
      reload();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Sync failed';
      toast.error('Notion sync failed', msg);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg lg:text-xl font-bold text-chrome-text">Active Disputes</h1>
        <div className="flex gap-2">
          <ActionButton
            label={syncing ? 'Syncing...' : 'Sync Notion'}
            variant="secondary"
            onClick={syncNotion}
            loading={syncing}
          />
          <ActionButton
            label={showCreateForm ? 'Close Form' : 'New Dispute'}
            variant={showCreateForm ? 'secondary' : 'primary'}
            onClick={() => setShowCreateForm((v) => !v)}
          />
        </div>
      </div>

      {showSyncStatus && lastSync && (
        <div className="flex items-center justify-between text-xs text-card-muted bg-card-hover border border-card-border rounded-lg px-3 py-2">
          <span>Last sync: {lastSync.pushed} pushed, {lastSync.reconciled} reconciled ({lastSync.duration_ms}ms)</span>
          <button onClick={() => setShowSyncStatus(false)} className="text-card-muted hover:text-card-text ml-2">&times;</button>
        </div>
      )}

      {error && (
        <Card urgency="red">
          <p className="text-urgency-red text-sm">{error}</p>
        </Card>
      )}

      {showCreateForm && (
        <Card>
          <h2 className="text-card-text font-semibold mb-3">Create Dispute</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input
              type="text"
              value={newDispute.title}
              onChange={(e) => setNewDispute((p) => ({ ...p, title: e.target.value }))}
              placeholder="Title"
              className="bg-card-bg border border-card-border rounded-lg px-3 py-2 text-sm text-card-text"
            />
            <input
              type="text"
              value={newDispute.counterparty}
              onChange={(e) => setNewDispute((p) => ({ ...p, counterparty: e.target.value }))}
              placeholder="Counterparty"
              className="bg-card-bg border border-card-border rounded-lg px-3 py-2 text-sm text-card-text"
            />
            <input
              type="text"
              value={newDispute.dispute_type}
              onChange={(e) => setNewDispute((p) => ({ ...p, dispute_type: e.target.value }))}
              placeholder="Dispute Type"
              className="bg-card-bg border border-card-border rounded-lg px-3 py-2 text-sm text-card-text"
            />
            <input
              type="number"
              step="0.01"
              value={newDispute.amount_at_stake}
              onChange={(e) => setNewDispute((p) => ({ ...p, amount_at_stake: e.target.value }))}
              placeholder="Amount At Stake"
              className="bg-card-bg border border-card-border rounded-lg px-3 py-2 text-sm text-card-text"
            />
            <select
              value={newDispute.priority}
              onChange={(e) => setNewDispute((p) => ({ ...p, priority: e.target.value }))}
              className="bg-card-bg border border-card-border rounded-lg px-3 py-2 text-sm text-card-text"
            >
              {Array.from({ length: 10 }, (_, i) => i + 1).map((p) => (
                <option key={p} value={String(p)}>Priority {p}</option>
              ))}
            </select>
            <input
              type="date"
              value={newDispute.next_action_date}
              onChange={(e) => setNewDispute((p) => ({ ...p, next_action_date: e.target.value }))}
              className="bg-card-bg border border-card-border rounded-lg px-3 py-2 text-sm text-card-text"
            />
          </div>
          <input
            type="text"
            value={newDispute.next_action}
            onChange={(e) => setNewDispute((p) => ({ ...p, next_action: e.target.value }))}
            placeholder="Next Action"
            className="w-full mt-2 bg-card-bg border border-card-border rounded-lg px-3 py-2 text-sm text-card-text"
          />
          <textarea
            value={newDispute.description}
            onChange={(e) => setNewDispute((p) => ({ ...p, description: e.target.value }))}
            placeholder="Description"
            className="w-full mt-2 bg-card-bg border border-card-border rounded-lg px-3 py-2 text-sm text-card-text h-20 resize-none"
          />
          <div className="mt-3 flex gap-2">
            <ActionButton
              label={creating ? 'Creating...' : 'Create Dispute'}
              onClick={submitCreateDispute}
              loading={creating}
              disabled={!newDispute.title.trim() || !newDispute.counterparty.trim()}
            />
            <ActionButton
              label="Cancel"
              variant="secondary"
              onClick={() => setShowCreateForm(false)}
            />
          </div>
        </Card>
      )}

      <div className="space-y-3">
        {disputes.map((d) => {
          const stage = normalizeStage(d);
          const stageIndex = DISPUTE_STAGES.indexOf(stage);
          return (
            <Card key={d.id} urgency={priorityUrgency(d.priority)}>
              <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 sm:gap-4 mb-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      (() => {
                        const severity = d.metadata?.triage_severity as string | undefined;
                        if (severity === 'CRITICAL') return 'bg-red-100 text-red-700';
                        if (severity === 'HIGH') return 'bg-orange-100 text-orange-700';
                        if (severity === 'MEDIUM') return 'bg-yellow-100 text-yellow-700';
                        if (severity === 'LOW') return 'bg-gray-100 text-gray-600';
                        // Fallback to existing priority-based coloring
                        if (d.priority <= 1) return 'bg-red-100 text-red-700';
                        if (d.priority <= 3) return 'bg-orange-100 text-orange-700';
                        return 'bg-gray-100 text-gray-600';
                      })()
                    }`}>
                      P{d.priority}
                    </span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-card-muted">
                      {d.dispute_type}
                    </span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-chitty-100 text-chitty-700">
                      {STAGE_LABELS[stage]}
                    </span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-card-hover text-card-muted uppercase">
                      {d.status}
                    </span>
                    {d.metadata?.notion_task_id ? (
                      d.metadata?.notion_url ? (
                        <a
                          href={d.metadata.notion_url as string}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 hover:bg-green-200 transition-colors"
                        >
                          Notion
                        </a>
                      ) : (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">
                          Notion
                        </span>
                      )
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-400">
                        Unlinked
                      </span>
                    )}
                    {!!d.metadata?.triage_severity && (
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        (() => {
                          const sev = d.metadata.triage_severity as string;
                          if (sev === 'CRITICAL') return 'bg-red-100 text-red-700';
                          if (sev === 'HIGH') return 'bg-orange-100 text-orange-700';
                          if (sev === 'MEDIUM') return 'bg-yellow-100 text-yellow-700';
                          return 'bg-gray-100 text-gray-600';
                        })()
                      }`}>
                        {(d.metadata.triage_severity as string)}
                      </span>
                    )}
                    {d.next_action_date && (() => {
                      const days = daysUntil(d.next_action_date);
                      const cls = countdownClasses(days);
                      return (
                        <span className={`text-xs px-2 py-0.5 rounded-full font-mono font-semibold ${cls.bg} ${cls.text}`}>
                          {days < 0 ? 'OVERDUE' : countdownLabel(days)}
                        </span>
                      );
                    })()}
                  </div>
                  <h2 className="text-base lg:text-lg font-semibold text-card-text">{d.title}</h2>
                  <p className="text-card-muted text-sm">vs {d.counterparty}</p>
                </div>
                {d.amount_at_stake && (
                  <div className="sm:text-right shrink-0">
                    <p className="text-card-muted text-xs">At Stake</p>
                    <p className="text-urgency-red text-lg lg:text-xl font-bold font-mono">{formatCurrency(d.amount_at_stake)}</p>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-1 mb-3 flex-wrap">
                {DISPUTE_STAGES.map((s, i) => {
                  const isCurrent = s === stage;
                  const isPast = i < stageIndex;
                  const isNext = i === stageIndex + 1;
                  return (
                    <button
                      key={s}
                      disabled={!isNext || advancingId === d.id}
                      onClick={() => isNext && advanceStage(d)}
                      className={`text-xs px-2 py-0.5 rounded-full transition-all ${
                        isCurrent
                          ? 'bg-chitty-500 text-white font-semibold'
                          : isPast
                            ? 'bg-chitty-100 text-chitty-700'
                            : isNext
                              ? 'bg-card-hover text-chitty-500 border border-chitty-300 cursor-pointer hover:bg-chitty-50'
                              : 'bg-card-hover text-card-muted border border-card-border cursor-default'
                      }`}
                      title={isNext ? `Advance to ${STAGE_LABELS[s]}` : STAGE_LABELS[s]}
                    >
                      {STAGE_LABELS[s]}
                    </button>
                  );
                })}
              </div>

              {d.description && (
                <p className="text-card-muted text-sm mb-3">{d.description}</p>
              )}

              {d.next_action && (
                <div className="bg-card-hover rounded-lg p-3 border border-card-border mb-3">
                  <p className="text-xs text-card-muted uppercase font-medium">Next Action</p>
                  <p className="text-chitty-600 text-sm mt-1 font-medium">{d.next_action}</p>
                  {d.next_action_date && (
                    <p className="text-card-muted text-xs mt-1">By {formatDate(d.next_action_date)}</p>
                  )}
                </div>
              )}

              <div className="flex gap-2 flex-wrap">
                <ActionButton
                  label="Correspondence"
                  variant={expandedId === d.id && activePanel === 'correspondence' ? 'primary' : 'secondary'}
                  onClick={() => togglePanel(d.id, 'correspondence')}
                />
                <ActionButton
                  label="Documents"
                  variant={expandedId === d.id && activePanel === 'documents' ? 'primary' : 'secondary'}
                  onClick={() => togglePanel(d.id, 'documents')}
                />
                <ActionButton
                  label="Deadlines"
                  variant={expandedId === d.id && activePanel === 'deadlines' ? 'primary' : 'secondary'}
                  onClick={() => togglePanel(d.id, 'deadlines')}
                />
              </div>

              {expandedId === d.id && activePanel === 'correspondence' && (
                <div className="mt-4 p-4 bg-card-hover rounded-lg border border-card-border">
                  <h3 className="text-card-text text-sm font-semibold mb-3">Correspondence</h3>
                  {panelError && (
                    <p className="text-urgency-red text-xs mb-3">{panelError}</p>
                  )}
                  {correspondenceList.length > 0 ? (
                    <div className="space-y-2 mb-4 max-h-48 overflow-y-auto">
                      {correspondenceList.map((c) => (
                        <div key={c.id} className="text-xs p-2 rounded-lg bg-card-bg border border-card-border">
                          <div className="flex justify-between text-card-muted">
                            <span>{c.direction} via {c.channel}</span>
                            <span>{formatDate(c.sent_at)}</span>
                          </div>
                          {c.subject && <p className="text-card-text mt-1 font-medium">{c.subject}</p>}
                          {c.content && <p className="text-card-muted mt-1">{c.content}</p>}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-card-muted text-xs mb-4">No correspondence yet</p>
                  )}
                  <div className="space-y-2">
                    <div className="flex flex-col sm:flex-row gap-2">
                      <select
                        value={newCorrespondence.direction}
                        onChange={(e) => setNewCorrespondence((p) => ({ ...p, direction: e.target.value as CorrespondenceDirection }))}
                        className="bg-card-bg border border-card-border rounded-lg px-2 py-1 text-xs text-card-text"
                      >
                        <option value="outbound">Outbound</option>
                        <option value="inbound">Inbound</option>
                      </select>
                      <select
                        value={newCorrespondence.channel}
                        onChange={(e) => setNewCorrespondence((p) => ({ ...p, channel: e.target.value as CorrespondenceChannel }))}
                        className="bg-card-bg border border-card-border rounded-lg px-2 py-1 text-xs text-card-text"
                      >
                        <option value="email">Email</option>
                        <option value="phone">Phone</option>
                        <option value="mail">Mail</option>
                        <option value="portal">Portal</option>
                        <option value="in_person">In Person</option>
                      </select>
                    </div>
                    <input
                      type="text"
                      placeholder="Subject"
                      value={newCorrespondence.subject}
                      onChange={(e) => setNewCorrespondence((p) => ({ ...p, subject: e.target.value }))}
                      className="w-full bg-card-bg border border-card-border rounded-lg px-3 py-1.5 text-sm text-card-text"
                    />
                    <textarea
                      placeholder="Notes (optional)"
                      value={newCorrespondence.content}
                      onChange={(e) => setNewCorrespondence((p) => ({ ...p, content: e.target.value }))}
                      className="w-full bg-card-bg border border-card-border rounded-lg px-3 py-1.5 text-sm text-card-text h-16 resize-none"
                    />
                    <ActionButton
                      label={saving ? 'Saving...' : 'Save'}
                      onClick={submitCorrespondence}
                      disabled={saving || !newCorrespondence.subject.trim()}
                    />
                  </div>
                </div>
              )}

              {expandedId === d.id && activePanel === 'documents' && (
                <div className="mt-4 p-4 bg-card-hover rounded-lg border border-card-border">
                  <h3 className="text-card-text text-sm font-semibold mb-3">Documents</h3>
                  {panelError && (
                    <p className="text-urgency-red text-xs mb-3">{panelError}</p>
                  )}
                  {documentList.length > 0 ? (
                    <div className="space-y-2 mb-3">
                      {documentList.map((doc) => (
                        <div key={doc.id} className="flex items-center justify-between text-xs p-2 rounded-lg bg-card-bg border border-card-border">
                          <div>
                            <p className="text-card-text font-medium">{doc.filename || 'Unnamed'}</p>
                            <p className="text-card-muted">{doc.doc_type} — {formatDate(doc.created_at)}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-card-muted text-xs mb-3">No documents linked yet.</p>
                  )}

                  <div className="space-y-2 border-t border-card-border pt-3">
                    <p className="text-xs text-card-muted">Upload directly to this dispute</p>
                    <input
                      type="file"
                      accept=".pdf,.png,.jpg,.jpeg,.webp,.csv,.txt"
                      onChange={(e) => setDocFile(e.target.files?.[0] || null)}
                      className="w-full text-xs text-card-muted"
                    />
                    <ActionButton
                      label={uploadingDoc ? 'Uploading...' : 'Upload Document'}
                      onClick={uploadFromDisputeContext}
                      loading={uploadingDoc}
                      disabled={!docFile}
                    />
                  </div>
                </div>
              )}

              {expandedId === d.id && activePanel === 'deadlines' && (
                <div className="mt-4 p-4 bg-card-hover rounded-lg border border-card-border">
                  <h3 className="text-card-text text-sm font-semibold mb-3">Legal Deadlines</h3>
                  {panelError && (
                    <p className="text-urgency-red text-xs mb-3">{panelError}</p>
                  )}
                  {deadlineList.length > 0 ? (
                    <div className="space-y-2">
                      {[...deadlineList]
                        .sort((a, b) => new Date(a.deadline_date).getTime() - new Date(b.deadline_date).getTime())
                        .map((dl) => {
                          const days = daysUntil(dl.deadline_date);
                          const cls = countdownClasses(days);
                          const isOverdue = days < 0;
                          return (
                            <div
                              key={dl.id}
                              className={`text-xs p-2 rounded-lg border ${
                                isOverdue
                                  ? 'bg-red-900/20 border-red-700'
                                  : days <= 3
                                    ? 'bg-red-900/10 border-red-700/50'
                                    : days <= 7
                                      ? 'bg-amber-900/10 border-amber-700/50'
                                      : 'bg-card-bg border-card-border'
                              }`}
                            >
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <span className="text-card-muted">{dl.deadline_type}</span>
                                  {isOverdue && (
                                    <span className="text-xs px-1.5 py-0.5 rounded font-semibold bg-red-600 text-white">
                                      OVERDUE
                                    </span>
                                  )}
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className={`px-1.5 py-0.5 rounded font-mono font-semibold ${cls.bg} ${cls.text}`}>
                                    {countdownLabel(days)}
                                  </span>
                                  <span className="text-card-muted">{formatDate(dl.deadline_date)}</span>
                                </div>
                              </div>
                              <p className="text-card-text mt-1 font-medium">{dl.title}</p>
                              <p className="text-card-muted mt-1">{dl.case_ref}</p>
                            </div>
                          );
                        })}
                    </div>
                  ) : (
                    <p className="text-card-muted text-xs">No linked deadlines for this dispute.</p>
                  )}
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {disputes.length === 0 && (
        <p className="text-chrome-muted text-center py-8">No active disputes</p>
      )}
    </div>
  );
}
