import { useEffect, useState, useCallback } from 'react';
import { api, type Task } from '../lib/api';
import { Card } from '../components/ui/Card';
import { ActionButton } from '../components/ui/ActionButton';
import { formatDate, cn } from '../lib/utils';
import { useToast } from '../lib/toast';
import { CheckCircle, Clock, AlertCircle, Loader2, ExternalLink } from 'lucide-react';

type StatusFilter = 'all' | 'pending' | 'in_progress' | 'done' | 'verified' | 'failed';

const STATUS_COLUMNS: { key: StatusFilter; label: string; color: string }[] = [
  { key: 'pending', label: 'Pending', color: 'border-t-amber-400' },
  { key: 'in_progress', label: 'In Progress', color: 'border-t-blue-400' },
  { key: 'done', label: 'Done', color: 'border-t-green-400' },
  { key: 'verified', label: 'Verified', color: 'border-t-emerald-400' },
];

const STATUS_BADGE: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-700',
  in_progress: 'bg-blue-100 text-blue-700',
  done: 'bg-green-100 text-green-700',
  verified: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-red-100 text-red-700',
  blocked: 'bg-gray-100 text-gray-700',
};

export function Tasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'kanban' | 'list'>('kanban');
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const toast = useToast();

  const loadTasks = useCallback(async () => {
    try {
      const params: { status?: string; limit: number } = { limit: 100 };
      if (filter !== 'all') params.status = filter;
      const data = await api.getTasks(params);
      setTasks(data.tasks);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { loadTasks(); }, [loadTasks]);

  const updateStatus = async (id: string, status: string) => {
    setUpdatingId(id);
    try {
      await api.updateTaskStatus(id, status);
      setTasks((prev) => prev.map((t) => t.id === id ? { ...t, backend_status: status } : t));
      toast.success('Task updated', `Status changed to ${status}`);
    } catch (e: unknown) {
      toast.error('Update failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setUpdatingId(null);
    }
  };

  if (loading) return <div className="text-chrome-muted py-8 text-center">Loading tasks...</div>;

  const grouped = tasks.reduce<Record<string, Task[]>>((acc, t) => {
    const key = t.backend_status;
    if (!acc[key]) acc[key] = [];
    acc[key].push(t);
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h1 className="text-lg lg:text-xl font-bold text-chrome-text">Task Board</h1>
        <div className="flex items-center gap-2">
          <div className="flex gap-1 bg-card-hover rounded-lg p-0.5 border border-card-border">
            <button
              onClick={() => setView('kanban')}
              className={cn('px-2.5 py-1 rounded-md text-xs font-medium transition-colors', view === 'kanban' ? 'bg-chitty-600 text-white' : 'text-card-muted')}
            >Kanban</button>
            <button
              onClick={() => setView('list')}
              className={cn('px-2.5 py-1 rounded-md text-xs font-medium transition-colors', view === 'list' ? 'bg-chitty-600 text-white' : 'text-card-muted')}
            >List</button>
          </div>
          <ActionButton label="Refresh" onClick={loadTasks} />
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 text-red-400 text-sm flex items-center gap-2">
          <AlertCircle size={16} /> {error}
        </div>
      )}

      {/* List view filter */}
      {view === 'list' && (
        <div className="flex gap-1 flex-wrap">
          {(['all', 'pending', 'in_progress', 'done', 'verified', 'failed'] as StatusFilter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'px-3 py-1 rounded-full text-xs font-medium transition-colors',
                filter === f ? 'bg-chitty-600 text-white' : 'bg-card-hover text-card-muted hover:text-card-text border border-card-border',
              )}
            >{f === 'all' ? 'All' : f.replace('_', ' ')}</button>
          ))}
        </div>
      )}

      {/* Kanban View */}
      {view === 'kanban' && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          {STATUS_COLUMNS.map((col) => (
            <div key={col.key} className={cn('rounded-xl bg-chrome-surface/50 border border-chrome-border p-3 border-t-2', col.color)}>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-chrome-text">{col.label}</h3>
                <span className="text-xs text-chrome-muted bg-chrome-border/50 px-2 py-0.5 rounded-full">
                  {(grouped[col.key] || []).length}
                </span>
              </div>
              <div className="space-y-2">
                {(grouped[col.key] || []).map((task) => (
                  <TaskCard key={task.id} task={task} onUpdateStatus={updateStatus} updatingId={updatingId} compact />
                ))}
                {!(grouped[col.key] || []).length && (
                  <p className="text-chrome-muted text-xs text-center py-4">No tasks</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* List View */}
      {view === 'list' && (
        <div className="space-y-2">
          {tasks.length === 0 ? (
            <Card className="text-center py-8">
              <p className="text-card-muted">No tasks found.</p>
            </Card>
          ) : (
            tasks.map((task) => (
              <TaskCard key={task.id} task={task} onUpdateStatus={updateStatus} updatingId={updatingId} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function TaskCard({
  task, onUpdateStatus, updatingId, compact,
}: {
  task: Task;
  onUpdateStatus: (id: string, status: string) => void;
  updatingId: string | null;
  compact?: boolean;
}) {
  const isUpdating = updatingId === task.id;
  const nextStatus: Record<string, string> = {
    pending: 'in_progress',
    in_progress: 'done',
    done: 'verified',
  };
  const next = nextStatus[task.backend_status];

  const priorityColor = task.priority <= 2 ? 'text-red-600' : task.priority <= 3 ? 'text-amber-600' : 'text-card-muted';

  return (
    <Card>
      <div className={cn('space-y-2', compact && 'space-y-1.5')}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
              <span className={cn('text-xs font-bold', priorityColor)}>P{task.priority}</span>
              <span className={cn('text-xs px-1.5 py-0.5 rounded-full font-medium', STATUS_BADGE[task.backend_status] || STATUS_BADGE.pending)}>
                {task.backend_status.replace('_', ' ')}
              </span>
              <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{task.task_type}</span>
            </div>
            <p className={cn('text-card-text font-medium', compact ? 'text-xs' : 'text-sm')}>{task.title}</p>
            {!compact && task.description && (
              <p className="text-card-muted text-xs mt-0.5 line-clamp-2">{task.description}</p>
            )}
          </div>
          {task.notion_page_id && (
            <a
              href={`https://notion.so/${task.notion_page_id.replace(/-/g, '')}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-card-muted hover:text-chitty-500 shrink-0"
              title="Open in Notion"
            >
              <ExternalLink size={14} />
            </a>
          )}
        </div>
        {!compact && (
          <div className="flex items-center gap-3 text-xs text-card-muted">
            {task.due_date && <span className="flex items-center gap-1"><Clock size={12} /> {formatDate(task.due_date)}</span>}
            {task.assigned_to && <span>Assigned: {task.assigned_to}</span>}
            <span>{task.source}</span>
          </div>
        )}
        {next && (
          <button
            onClick={() => onUpdateStatus(task.id, next)}
            disabled={isUpdating}
            className="flex items-center gap-1.5 text-xs font-medium text-chitty-600 hover:text-chitty-500 transition-colors disabled:opacity-50"
          >
            {isUpdating ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle size={12} />}
            Move to {next.replace('_', ' ')}
          </button>
        )}
      </div>
    </Card>
  );
}
