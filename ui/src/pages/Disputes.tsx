import { useEffect, useState, useCallback } from 'react';
import { api, type Dispute, type Correspondence } from '../lib/api';
import { Card } from '../components/ui/Card';
import { ActionButton } from '../components/ui/ActionButton';
import { ProgressDots } from '../components/ui/ProgressDots';
import { formatCurrency, formatDate } from '../lib/utils';

const DISPUTE_STAGES = ['filed', 'response_pending', 'in_review', 'resolved'];

function disputeStageIndex(status: string): number {
  const idx = DISPUTE_STAGES.indexOf(status);
  return idx >= 0 ? idx : 0;
}

export function Disputes() {
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [correspondenceList, setCorrespondenceList] = useState<Correspondence[]>([]);
  const [documentList, setDocumentList] = useState<{ id: string; filename: string | null; doc_type: string; created_at: string }[]>([]);
  const [activePanel, setActivePanel] = useState<'correspondence' | 'documents' | null>(null);
  const [newCorrespondence, setNewCorrespondence] = useState({ direction: 'outbound', channel: 'email', subject: '', content: '' });
  const [saving, setSaving] = useState(false);

  const reload = useCallback(() => {
    api.getDisputes('open').then(setDisputes).catch((e) => setError(e.message));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const [panelError, setPanelError] = useState<string | null>(null);

  const togglePanel = async (disputeId: string, panel: 'correspondence' | 'documents') => {
    if (expandedId === disputeId && activePanel === panel) {
      setExpandedId(null);
      setActivePanel(null);
      setPanelError(null);
      return;
    }
    setExpandedId(disputeId);
    setActivePanel(panel);
    setPanelError(null);
    try {
      const detail = await api.getDispute(disputeId);
      if (panel === 'correspondence') setCorrespondenceList(detail.correspondence || []);
      else setDocumentList(detail.documents || []);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to load';
      console.error(`[Disputes] ${panel} load failed for ${disputeId}:`, msg, e);
      setPanelError(`Unable to load ${panel}: ${msg}`);
      if (panel === 'correspondence') setCorrespondenceList([]);
      else setDocumentList([]);
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
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to add correspondence');
    } finally {
      setSaving(false);
    }
  };

  if (error) return <p className="text-urgency-red">{error}</p>;

  const priorityUrgency = (p: number): 'red' | 'amber' | 'green' => {
    if (p <= 1) return 'red';
    if (p <= 3) return 'amber';
    return 'green';
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold text-chrome-text">Active Disputes</h1>

      <div className="space-y-3">
        {disputes.map((d) => (
          <Card key={d.id} urgency={priorityUrgency(d.priority)}>
            <div className="flex items-start justify-between gap-4 mb-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-red-100 text-red-700">
                    P{d.priority}
                  </span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-card-muted">
                    {d.dispute_type}
                  </span>
                </div>
                <h2 className="text-lg font-semibold text-card-text">{d.title}</h2>
                <p className="text-card-muted text-sm">vs {d.counterparty}</p>
              </div>
              {d.amount_at_stake && (
                <div className="text-right shrink-0">
                  <p className="text-card-muted text-xs">At Stake</p>
                  <p className="text-urgency-red text-xl font-bold font-mono">{formatCurrency(d.amount_at_stake)}</p>
                </div>
              )}
            </div>

            <ProgressDots completed={disputeStageIndex(d.status) + 1} total={DISPUTE_STAGES.length} className="mb-3" />

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

            <div className="flex gap-2">
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
            </div>

            {/* Correspondence Panel */}
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
                  <div className="flex gap-2">
                    <select
                      value={newCorrespondence.direction}
                      onChange={(e) => setNewCorrespondence({ ...newCorrespondence, direction: e.target.value })}
                      className="bg-card-bg border border-card-border rounded-lg px-2 py-1 text-xs text-card-text"
                    >
                      <option value="outbound">Outbound</option>
                      <option value="inbound">Inbound</option>
                    </select>
                    <select
                      value={newCorrespondence.channel}
                      onChange={(e) => setNewCorrespondence({ ...newCorrespondence, channel: e.target.value })}
                      className="bg-card-bg border border-card-border rounded-lg px-2 py-1 text-xs text-card-text"
                    >
                      <option value="email">Email</option>
                      <option value="phone">Phone</option>
                      <option value="mail">Mail</option>
                      <option value="portal">Portal</option>
                    </select>
                  </div>
                  <input
                    type="text"
                    placeholder="Subject"
                    value={newCorrespondence.subject}
                    onChange={(e) => setNewCorrespondence({ ...newCorrespondence, subject: e.target.value })}
                    className="w-full bg-card-bg border border-card-border rounded-lg px-3 py-1.5 text-sm text-card-text"
                  />
                  <textarea
                    placeholder="Notes (optional)"
                    value={newCorrespondence.content}
                    onChange={(e) => setNewCorrespondence({ ...newCorrespondence, content: e.target.value })}
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

            {/* Documents Panel */}
            {expandedId === d.id && activePanel === 'documents' && (
              <div className="mt-4 p-4 bg-card-hover rounded-lg border border-card-border">
                <h3 className="text-card-text text-sm font-semibold mb-3">Documents</h3>
                {panelError && (
                  <p className="text-urgency-red text-xs mb-3">{panelError}</p>
                )}
                {documentList.length > 0 ? (
                  <div className="space-y-2">
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
                  <p className="text-card-muted text-xs">No documents linked — upload from the Upload page</p>
                )}
              </div>
            )}
          </Card>
        ))}
      </div>

      {disputes.length === 0 && (
        <p className="text-chrome-muted text-center py-8">No active disputes</p>
      )}
    </div>
  );
}
