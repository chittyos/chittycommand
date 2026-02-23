import { useEffect, useState, useCallback } from 'react';
import { api, type Dispute, type Correspondence } from '../lib/api';
import { formatCurrency, formatDate } from '../lib/utils';

export function Disputes() {
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [correspondenceFor, setCorrespondenceFor] = useState<string | null>(null);
  const [documentsFor, setDocumentsFor] = useState<string | null>(null);
  const [statusFor, setStatusFor] = useState<string | null>(null);
  const [correspondenceList, setCorrespondenceList] = useState<Correspondence[]>([]);
  const [documentList, setDocumentList] = useState<{ id: string; filename: string | null; doc_type: string; created_at: string }[]>([]);
  const [newCorrespondence, setNewCorrespondence] = useState({ direction: 'outbound', channel: 'email', subject: '', content: '' });
  const [saving, setSaving] = useState(false);

  const reload = useCallback(() => {
    api.getDisputes('open').then(setDisputes).catch((e) => setError(e.message));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const openCorrespondence = async (disputeId: string) => {
    setCorrespondenceFor(disputeId);
    try {
      const detail = await api.getDispute(disputeId);
      setCorrespondenceList(detail.correspondence || []);
    } catch { setCorrespondenceList([]); }
  };

  const openDocuments = async (disputeId: string) => {
    setDocumentsFor(disputeId);
    try {
      const detail = await api.getDispute(disputeId);
      setDocumentList(detail.documents || []);
    } catch { setDocumentList([]); }
  };

  const submitCorrespondence = async () => {
    if (!correspondenceFor || !newCorrespondence.subject.trim()) return;
    setSaving(true);
    try {
      await api.addCorrespondence(correspondenceFor, newCorrespondence);
      setNewCorrespondence({ direction: 'outbound', channel: 'email', subject: '', content: '' });
      const detail = await api.getDispute(correspondenceFor);
      setCorrespondenceList(detail.correspondence || []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to add correspondence');
    } finally { setSaving(false); }
  };

  if (error) return <p className="text-red-400">{error}</p>;

  const priorityColor = (p: number) => {
    if (p <= 1) return 'bg-red-600';
    if (p <= 3) return 'bg-orange-600';
    return 'bg-yellow-600';
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Active Disputes</h1>

      <div className="grid grid-cols-1 gap-4">
        {disputes.map((d) => (
          <div key={d.id} className="bg-[#161822] rounded-lg border border-gray-800 p-5">
            <div className="flex items-start justify-between mb-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className={`text-xs px-2 py-0.5 rounded text-white ${priorityColor(d.priority)}`}>
                    P{d.priority}
                  </span>
                  <span className="text-xs px-2 py-0.5 rounded bg-gray-700 text-gray-300">
                    {d.dispute_type}
                  </span>
                </div>
                <h2 className="text-lg font-semibold text-white mt-2">{d.title}</h2>
                <p className="text-gray-400 text-sm">vs {d.counterparty}</p>
              </div>
              {d.amount_at_stake && (
                <div className="text-right">
                  <p className="text-gray-400 text-xs">At Stake</p>
                  <p className="text-red-400 text-xl font-bold font-mono">{formatCurrency(d.amount_at_stake)}</p>
                </div>
              )}
            </div>

            {d.description && (
              <p className="text-gray-300 text-sm mb-3">{d.description}</p>
            )}

            {d.next_action && (
              <div className="bg-[#1c1f2e] rounded p-3 border border-gray-700">
                <p className="text-xs text-gray-500 uppercase">Next Action</p>
                <p className="text-chitty-500 text-sm mt-1">{d.next_action}</p>
                {d.next_action_date && (
                  <p className="text-gray-500 text-xs mt-1">By {formatDate(d.next_action_date)}</p>
                )}
              </div>
            )}

            <div className="flex gap-2 mt-4">
              <button
                onClick={() => openCorrespondence(d.id)}
                className="px-3 py-1.5 text-sm bg-chitty-600 text-white rounded hover:bg-chitty-700"
              >
                Add Correspondence
              </button>
              <button
                onClick={() => openDocuments(d.id)}
                className="px-3 py-1.5 text-sm bg-gray-700 text-gray-300 rounded hover:bg-gray-600"
              >
                View Documents
              </button>
              <button
                onClick={() => setStatusFor(statusFor === d.id ? null : d.id)}
                className="px-3 py-1.5 text-sm bg-gray-700 text-gray-300 rounded hover:bg-gray-600"
              >
                Update Status
              </button>
            </div>

            {/* Correspondence Panel */}
            {correspondenceFor === d.id && (
              <div className="mt-4 p-4 bg-[#1c1f2e] rounded border border-gray-700">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-white text-sm font-semibold">Correspondence</h3>
                  <button onClick={() => setCorrespondenceFor(null)} className="text-gray-500 hover:text-white text-xs">Close</button>
                </div>
                {correspondenceList.length > 0 ? (
                  <div className="space-y-2 mb-4 max-h-48 overflow-y-auto">
                    {correspondenceList.map((c) => (
                      <div key={c.id} className="text-xs p-2 rounded bg-[#161822] border border-gray-800">
                        <div className="flex justify-between text-gray-400">
                          <span>{c.direction} via {c.channel}</span>
                          <span>{formatDate(c.sent_at)}</span>
                        </div>
                        {c.subject && <p className="text-white mt-1">{c.subject}</p>}
                        {c.content && <p className="text-gray-300 mt-1">{c.content}</p>}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-gray-500 text-xs mb-4">No correspondence yet</p>
                )}
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <select
                      value={newCorrespondence.direction}
                      onChange={(e) => setNewCorrespondence({ ...newCorrespondence, direction: e.target.value })}
                      className="bg-[#161822] border border-gray-700 rounded px-2 py-1 text-xs text-white"
                    >
                      <option value="outbound">Outbound</option>
                      <option value="inbound">Inbound</option>
                    </select>
                    <select
                      value={newCorrespondence.channel}
                      onChange={(e) => setNewCorrespondence({ ...newCorrespondence, channel: e.target.value })}
                      className="bg-[#161822] border border-gray-700 rounded px-2 py-1 text-xs text-white"
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
                    className="w-full bg-[#161822] border border-gray-700 rounded px-3 py-1.5 text-sm text-white"
                  />
                  <textarea
                    placeholder="Notes (optional)"
                    value={newCorrespondence.content}
                    onChange={(e) => setNewCorrespondence({ ...newCorrespondence, content: e.target.value })}
                    className="w-full bg-[#161822] border border-gray-700 rounded px-3 py-1.5 text-sm text-white h-16 resize-none"
                  />
                  <button
                    onClick={submitCorrespondence}
                    disabled={saving || !newCorrespondence.subject.trim()}
                    className="px-3 py-1.5 text-sm bg-chitty-600 text-white rounded hover:bg-chitty-700 disabled:opacity-50"
                  >
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
            )}

            {/* Documents Panel */}
            {documentsFor === d.id && (
              <div className="mt-4 p-4 bg-[#1c1f2e] rounded border border-gray-700">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-white text-sm font-semibold">Documents</h3>
                  <button onClick={() => setDocumentsFor(null)} className="text-gray-500 hover:text-white text-xs">Close</button>
                </div>
                {documentList.length > 0 ? (
                  <div className="space-y-2">
                    {documentList.map((doc) => (
                      <div key={doc.id} className="flex items-center justify-between text-xs p-2 rounded bg-[#161822] border border-gray-800">
                        <div>
                          <p className="text-white">{doc.filename || 'Unnamed'}</p>
                          <p className="text-gray-400">{doc.doc_type} — {formatDate(doc.created_at)}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-gray-500 text-xs">No documents linked — upload from the Upload page</p>
                )}
              </div>
            )}

            {/* Update Status Panel */}
            {statusFor === d.id && (
              <div className="mt-4 p-4 bg-[#1c1f2e] rounded border border-gray-700">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-white text-sm font-semibold">Update Status</h3>
                  <button onClick={() => setStatusFor(null)} className="text-gray-500 hover:text-white text-xs">Close</button>
                </div>
                <p className="text-gray-400 text-xs mb-2">Current: <span className="text-white">{d.status}</span></p>
                <p className="text-gray-500 text-xs">Status updates are managed via the API. Use the dispute detail endpoint or the AI recommendations to progress this dispute.</p>
              </div>
            )}
          </div>
        ))}
      </div>

      {disputes.length === 0 && (
        <p className="text-gray-500 text-center py-8">No active disputes</p>
      )}
    </div>
  );
}
