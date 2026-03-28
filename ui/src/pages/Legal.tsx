import { useEffect, useState } from 'react';
import { api, type LegalDeadline } from '../lib/api';
import { formatDate, daysUntil, cn } from '../lib/utils';
import { Card } from '../components/ui/Card';
import { ActionButton } from '../components/ui/ActionButton';
import { useToast } from '../lib/toast';
import { Link } from 'react-router-dom';
import { Plus, X, CheckCircle } from 'lucide-react';

export function Legal() {
  const [deadlines, setDeadlines] = useState<LegalDeadline[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const toast = useToast();

  // Create form state
  const [form, setForm] = useState({
    case_ref: '',
    deadline_type: 'filing',
    title: '',
    deadline_date: '',
    description: '',
  });

  const load = () => {
    setError(null);
    api.getLegalDeadlines().then(setDeadlines).catch((e) => setError(e.message));
  };

  useEffect(load, []);

  const handleCreate = async () => {
    if (!form.case_ref || !form.title || !form.deadline_date) return;
    setCreating(true);
    try {
      await api.createLegalDeadline(form);
      setShowCreate(false);
      setForm({ case_ref: '', deadline_type: 'filing', title: '', deadline_date: '', description: '' });
      load();
      toast.success('Deadline created', form.title);
    } catch (e: unknown) {
      toast.error('Create failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setCreating(false);
    }
  };

  const markComplete = async (id: string) => {
    try {
      await api.updateLegalDeadline(id, { status: 'completed' });
      setDeadlines(prev => prev.filter(d => d.id !== id));
      toast.success('Deadline completed', 'Marked as done');
    } catch (e: unknown) {
      toast.error('Update failed', e instanceof Error ? e.message : 'Unknown error');
    }
  };

  if (error && deadlines.length === 0) {
    return <div className="bg-red-50 border border-red-200 rounded-card p-3 text-urgency-red text-sm">{error}</div>;
  }

  const urgencyFromDays = (days: number): 'red' | 'amber' | 'green' | null => {
    if (days < 0) return 'red';
    if (days <= 7) return 'amber';
    if (days <= 30) return 'green';
    return null;
  };

  const countdownColor = (days: number): string => {
    if (days < 0) return 'text-urgency-red';
    if (days <= 7) return 'text-urgency-amber';
    if (days <= 30) return 'text-urgency-amber';
    return 'text-card-muted';
  };

  const deadlineTypes = ['filing', 'hearing', 'response', 'discovery', 'motion', 'trial', 'appeal', 'other'];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h1 className="text-lg lg:text-xl font-bold text-chrome-text">Legal Deadlines</h1>
        <ActionButton
          label={showCreate ? 'Cancel' : 'Add Deadline'}
          variant={showCreate ? 'secondary' : 'primary'}
          onClick={() => setShowCreate(!showCreate)}
        />
      </div>

      {/* Create form */}
      {showCreate && (
        <Card>
          <div className="space-y-3">
            <div className="flex items-center gap-2 mb-1">
              <Plus size={16} className="text-chitty-500" />
              <h3 className="font-semibold text-card-text text-sm">New Deadline</h3>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-card-muted mb-1">Case Reference *</label>
                <input
                  value={form.case_ref}
                  onChange={(e) => setForm(f => ({ ...f, case_ref: e.target.value }))}
                  placeholder="e.g. 2024D007847"
                  className="w-full px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-card-text text-sm focus:outline-none focus:ring-2 focus:ring-chitty-500/50"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-card-muted mb-1">Type *</label>
                <select
                  value={form.deadline_type}
                  onChange={(e) => setForm(f => ({ ...f, deadline_type: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-card-text text-sm focus:outline-none"
                >
                  {deadlineTypes.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-card-muted mb-1">Title *</label>
                <input
                  value={form.title}
                  onChange={(e) => setForm(f => ({ ...f, title: e.target.value }))}
                  placeholder="e.g. Response to Motion to Dismiss"
                  className="w-full px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-card-text text-sm focus:outline-none focus:ring-2 focus:ring-chitty-500/50"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-card-muted mb-1">Deadline Date *</label>
                <input
                  type="date"
                  value={form.deadline_date}
                  onChange={(e) => setForm(f => ({ ...f, deadline_date: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-card-text text-sm focus:outline-none focus:ring-2 focus:ring-chitty-500/50"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-card-muted mb-1">Description</label>
                <input
                  value={form.description}
                  onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="Optional details"
                  className="w-full px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-card-text text-sm focus:outline-none focus:ring-2 focus:ring-chitty-500/50"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <ActionButton label="Cancel" variant="secondary" onClick={() => setShowCreate(false)} />
              <ActionButton
                label={creating ? 'Creating...' : 'Create Deadline'}
                onClick={handleCreate}
                loading={creating}
                disabled={!form.case_ref || !form.title || !form.deadline_date}
              />
            </div>
          </div>
        </Card>
      )}

      <div className="space-y-2">
        {deadlines.map((dl) => {
          const days = daysUntil(dl.deadline_date);
          const isPast = days < 0;

          return (
            <Card key={dl.id} urgency={urgencyFromDays(days)}>
              <div className="flex items-center justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 font-medium">
                      {dl.deadline_type}
                    </span>
                    <span className="text-xs text-card-muted">{dl.case_ref}</span>
                    {dl.dispute_id && (
                      <Link
                        to={`/disputes?expand=${dl.dispute_id}`}
                        className="text-xs px-2 py-0.5 rounded-full bg-chitty-100 text-chitty-700 hover:bg-chitty-200"
                      >
                        {dl.dispute_title ? `Dispute: ${dl.dispute_title}` : 'Open Dispute'}
                      </Link>
                    )}
                  </div>
                  <h3 className="text-card-text font-medium mt-1">{dl.title}</h3>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <p className={cn('text-lg font-mono font-bold', countdownColor(days))}>
                      {isPast ? `${Math.abs(days)}d PAST` : days === 0 ? 'TODAY' : `${days}d`}
                    </p>
                    <p className="text-card-muted text-xs">{formatDate(dl.deadline_date)}</p>
                  </div>
                  <button
                    onClick={() => markComplete(dl.id)}
                    className="text-card-muted hover:text-emerald-600 transition-colors p-1"
                    title="Mark complete"
                  >
                    <CheckCircle size={18} />
                  </button>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      {deadlines.length === 0 && !showCreate && (
        <Card className="text-center py-8">
          <p className="text-card-muted">No upcoming legal deadlines</p>
          <p className="text-card-muted text-sm mt-1">Click "Add Deadline" to create one.</p>
        </Card>
      )}
    </div>
  );
}
