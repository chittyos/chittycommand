import { useEffect, useState, useMemo, useCallback } from 'react';
import { api, type Task } from '../lib/api';
import { formatDate, daysUntil, cn } from '../lib/utils';
import {
  Bot, RefreshCw, Clock, Play, CheckCircle2, XCircle, Ban,
  ChevronRight, ArrowRight, AlertTriangle,
} from 'lucide-react';

// ── Status columns matching Notion Agent Task Board ──────────

type BoardStatus = 'pending' | 'claimed' | 'running' | 'completed' | 'failed' | 'blocked';

const COLUMNS: { status: BoardStatus; label: string; tactical: string; icon: typeof Clock; cssVar: string }[] = [
  { status: 'pending',   label: 'Pending',   tactical: 'QUEUE',    icon: Clock,        cssVar: '--ab-pending' },
  { status: 'claimed',   label: 'Claimed',   tactical: 'ASSIGNED', icon: ArrowRight,   cssVar: '--ab-claimed' },
  { status: 'running',   label: 'Running',   tactical: 'ACTIVE',   icon: Play,         cssVar: '--ab-running' },
  { status: 'completed', label: 'Done',      tactical: 'SHIPPED',  icon: CheckCircle2, cssVar: '--ab-completed' },
  { status: 'failed',    label: 'Failed',    tactical: 'ERROR',    icon: XCircle,      cssVar: '--ab-failed' },
  { status: 'blocked',   label: 'Blocked',   tactical: 'WAITING',  icon: Ban,          cssVar: '--ab-blocked' },
];

// Map backend_status values to board columns
function mapStatus(backendStatus: string): BoardStatus {
  const s = backendStatus.toLowerCase();
  if (s === 'pending' || s === 'open' || s === 'new') return 'pending';
  if (s === 'claimed' || s === 'assigned') return 'claimed';
  if (s === 'running' || s === 'in_progress' || s === 'active') return 'running';
  if (s === 'completed' || s === 'done' || s === 'resolved' || s === 'verified') return 'completed';
  if (s === 'failed' || s === 'error') return 'failed';
  if (s === 'blocked' || s === 'waiting' || s === 'deferred') return 'blocked';
  return 'pending';
}

// Agent name badge colors
const AGENT_COLORS: Record<string, string> = {
  'chittyagent-tasks': 'ab-agent--blue',
  'chittyagent-notion': 'ab-agent--purple',
  'chittyagent-ui': 'ab-agent--green',
  'chittyagent-notes': 'ab-agent--yellow',
  'chittyagent-ship': 'ab-agent--orange',
  'chittyagent-dispute': 'ab-agent--red',
  'chittyagent-imessage': 'ab-agent--pink',
  'chittyagent-canon': 'ab-agent--gray',
  'chittyagent-chatgpt': 'ab-agent--brown',
  'chittyagent-cleaner': 'ab-agent--slate',
  'chittyagent-cloudflare': 'ab-agent--blue',
  'chittyagent-finance': 'ab-agent--green',
  'chittyagent-helper': 'ab-agent--purple',
  'chittyagent-orchestrator': 'ab-agent--orange',
  'chittyagent-resolve': 'ab-agent--red',
};

// Task type badge labels
const TYPE_LABELS: Record<string, string> = {
  evidence_ingest: 'Evidence',
  email_monitor: 'Email',
  note_sync: 'Notes',
  error_triage: 'Triage',
  notion_sync: 'Notion',
  deploy: 'Deploy',
  cleanup: 'Cleanup',
  general: 'General',
  legal: 'Legal',
  financial: 'Finance',
  compliance: 'Compliance',
  dispute: 'Dispute',
};

// ── Component ────────────────────────────────────────────────

export function AgentBoard() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getTasks({ limit: 200 });
      setTasks(Array.isArray(res) ? res : res.tasks ?? []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const grouped = useMemo(() => {
    const result: Record<BoardStatus, Task[]> = {
      pending: [], claimed: [], running: [], completed: [], failed: [], blocked: [],
    };
    for (const task of tasks) {
      const status = mapStatus(task.backend_status);
      if (status === 'completed' && !showCompleted) continue;
      result[status].push(task);
    }
    // Sort each column by priority (lower = higher priority)
    for (const col of Object.values(result)) {
      col.sort((a, b) => a.priority - b.priority);
    }
    return result;
  }, [tasks, showCompleted]);

  const activeCols = useMemo(() => {
    if (showCompleted) return COLUMNS;
    // Always show pending/claimed/running/failed/blocked; hide completed if empty and toggled off
    return COLUMNS.filter(c => c.status !== 'completed' || grouped.completed.length > 0);
  }, [showCompleted, grouped]);

  const totalByStatus = useMemo(() => {
    const counts: Record<BoardStatus, number> = { pending: 0, claimed: 0, running: 0, completed: 0, failed: 0, blocked: 0 };
    for (const task of tasks) {
      counts[mapStatus(task.backend_status)]++;
    }
    return counts;
  }, [tasks]);

  if (loading) {
    return (
      <div className="ab-loading">
        <Bot size={32} className="ab-loading-icon" />
        <p>Loading agent operations...</p>
      </div>
    );
  }

  return (
    <div className="ab-root">
      {/* Header */}
      <div className="ab-header">
        <div className="ab-header-left">
          <Bot size={20} className="ab-header-icon" />
          <div>
            <h1 className="ab-title">Agent Board</h1>
            <p className="ab-subtitle">
              {tasks.length} tasks &middot; {totalByStatus.running} running &middot; {totalByStatus.pending} queued
            </p>
          </div>
        </div>
        <div className="ab-header-actions">
          <button
            onClick={() => setShowCompleted(!showCompleted)}
            className={cn('ab-toggle', showCompleted && 'ab-toggle--active')}
          >
            <CheckCircle2 size={14} />
            <span>{showCompleted ? 'Hide' : 'Show'} done ({totalByStatus.completed})</span>
          </button>
          <button onClick={load} className="ab-refresh" title="Reload">
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      {error && (
        <div className="ab-error">
          <AlertTriangle size={14} />
          <span>{error}</span>
        </div>
      )}

      {/* Kanban board */}
      <div className="ab-board" style={{ '--ab-cols': activeCols.length } as React.CSSProperties}>
        {activeCols.map((col) => {
          const Icon = col.icon;
          const items = grouped[col.status];
          return (
            <div key={col.status} className={`ab-column ab-column--${col.status}`}>
              <div className="ab-column-header">
                <Icon size={14} className="ab-column-icon" />
                <span className="ab-column-label">{col.label}</span>
                <span className="ab-column-tactical">{col.tactical}</span>
                {items.length > 0 && (
                  <span className="ab-column-count">{items.length}</span>
                )}
              </div>
              <div className="ab-column-list">
                {items.length === 0 ? (
                  <div className="ab-empty">
                    {col.status === 'failed' ? 'No failures' : col.status === 'blocked' ? 'Nothing blocked' : 'Empty'}
                  </div>
                ) : (
                  items.map((task, idx) => (
                    <TaskCard key={task.id} task={task} index={idx} />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Task card ────────────────────────────────────────────────

function TaskCard({ task, index }: { task: Task; index: number }) {
  const agent = task.assigned_to || task.source || '';
  const agentShort = agent.replace('chittyagent-', '').replace('notion-task-triager', 'triager');
  const agentClass = AGENT_COLORS[agent] || 'ab-agent--slate';
  const typeLabel = TYPE_LABELS[task.task_type] || task.task_type;
  const hasDue = Boolean(task.due_date);
  const days = hasDue ? daysUntil(task.due_date!) : null;
  const overdue = days !== null && days < 0;

  return (
    <div className="ab-card" style={{ animationDelay: `${index * 30}ms` }}>
      <div className="ab-card-top">
        <span className="ab-card-type">{typeLabel}</span>
        {agentShort && (
          <span className={cn('ab-card-agent', agentClass)}>{agentShort}</span>
        )}
      </div>
      <div className="ab-card-title">{task.title}</div>
      {task.description && (
        <div className="ab-card-desc">{task.description}</div>
      )}
      <div className="ab-card-footer">
        <span className="ab-card-priority" title={`Priority ${task.priority}`}>
          P{task.priority}
        </span>
        {hasDue && (
          <span className={cn('ab-card-date', overdue && 'ab-card-date--overdue')}>
            {overdue ? `${Math.abs(days!)}d late` : days === 0 ? 'Today' : days !== null && days <= 14 ? `${days}d` : formatDate(task.due_date!)}
          </span>
        )}
        {task.verification_type && task.verification_type !== 'none' && (
          <span className="ab-card-verify" title={`Verification: ${task.verification_type}`}>
            <ChevronRight size={10} />
            {task.verification_type}
          </span>
        )}
      </div>
    </div>
  );
}
