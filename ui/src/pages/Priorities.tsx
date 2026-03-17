import { useEffect, useState, useMemo } from 'react';
import { api, type Obligation, type Dispute, type Task, type Recommendation } from '../lib/api';
import { formatCurrency, formatDate, daysUntil } from '../lib/utils';
import {
  Crosshair, Flame, CalendarClock, Users, Trash2,
  Receipt, ShieldAlert, ListChecks, Lightbulb,
  AlertTriangle, RefreshCw,
} from 'lucide-react';

// ── Quadrant types ───────────────────────────────────────────

type Quadrant = 'do_first' | 'schedule' | 'delegate' | 'eliminate';
type SourceKind = 'obligation' | 'dispute' | 'task' | 'recommendation';

interface PriorityItem {
  id: string;
  kind: SourceKind;
  title: string;
  subtitle: string | null;
  amount: string | null;
  dueDate: string | null;
  daysLeft: number | null;
  urgencyScore: number | null;
  priority: number;
  status: string;
  quadrant: Quadrant;
}

// ── Classification logic ─────────────────────────────────────

function classifyObligation(ob: Obligation): Quadrant {
  const score = ob.urgency_score ?? 0;
  const due = ob.due_date ? daysUntil(ob.due_date) : 999;
  const amount = parseFloat(ob.amount_due ?? '0');
  const isImportant = amount >= 200 || ob.category === 'mortgage' || ob.category === 'legal' || ob.category === 'tax';
  const isUrgent = score >= 50 || due <= 7 || ob.status === 'overdue';
  if (isImportant && isUrgent) return 'do_first';
  if (isImportant) return 'schedule';
  if (isUrgent) return 'delegate';
  return 'eliminate';
}

function classifyDispute(d: Dispute): Quadrant {
  const isImportant = d.priority <= 2 || parseFloat(d.amount_at_stake ?? '0') >= 1000;
  const isUrgent = d.next_action_date ? daysUntil(d.next_action_date) <= 7 : d.status === 'open';
  if (isImportant && isUrgent) return 'do_first';
  if (isImportant) return 'schedule';
  if (isUrgent) return 'delegate';
  return 'eliminate';
}

function classifyTask(t: Task): Quadrant {
  const isImportant = t.priority <= 2 || t.task_type === 'legal' || t.task_type === 'financial';
  const isUrgent = t.due_date ? daysUntil(t.due_date) <= 7 : t.priority <= 1;
  if (isImportant && isUrgent) return 'do_first';
  if (isImportant) return 'schedule';
  if (isUrgent) return 'delegate';
  return 'eliminate';
}

function classifyRecommendation(r: Recommendation): Quadrant {
  const isImportant = r.priority <= 2 || r.rec_type === 'legal' || r.rec_type === 'payment';
  const isUrgent = r.priority <= 1 || r.action_type === 'pay_now';
  if (isImportant && isUrgent) return 'do_first';
  if (isImportant) return 'schedule';
  if (isUrgent) return 'delegate';
  return 'eliminate';
}

// ── Quadrant metadata ────────────────────────────────────────

const QUADRANTS: Record<Quadrant, { label: string; tactical: string; icon: typeof Flame; cssClass: string }> = {
  do_first: {
    label: 'Do First',
    tactical: 'CRITICAL — ACT NOW',
    icon: Flame,
    cssClass: 'eisenhower-q1',
  },
  schedule: {
    label: 'Schedule',
    tactical: 'STRATEGIC — PLAN IT',
    icon: CalendarClock,
    cssClass: 'eisenhower-q2',
  },
  delegate: {
    label: 'Delegate',
    tactical: 'TACTICAL — HAND OFF',
    icon: Users,
    cssClass: 'eisenhower-q3',
  },
  eliminate: {
    label: 'Eliminate',
    tactical: 'LOW VALUE — DROP IT',
    icon: Trash2,
    cssClass: 'eisenhower-q4',
  },
};

const KIND_ICON: Record<SourceKind, typeof Receipt> = {
  obligation: Receipt,
  dispute: ShieldAlert,
  task: ListChecks,
  recommendation: Lightbulb,
};

const KIND_LABEL: Record<SourceKind, string> = {
  obligation: 'Bill',
  dispute: 'Dispute',
  task: 'Task',
  recommendation: 'Rec',
};

// ── Component ────────────────────────────────────────────────

export function Priorities() {
  const [obligations, setObligations] = useState<Obligation[]>([]);
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [recs, setRecs] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [obRes, dispRes, taskRes, recRes] = await Promise.all([
        api.getObligations().catch(() => [] as Obligation[]),
        api.getDisputes().catch(() => [] as Dispute[]),
        api.getTasks({ limit: 100 }).catch(() => ({ tasks: [] as Task[], total: 0, limit: 100, offset: 0 })),
        api.getRecommendations().catch(() => [] as Recommendation[]),
      ]);
      setObligations(obRes.filter(o => o.status !== 'paid'));
      setDisputes(dispRes.filter(d => d.status !== 'resolved' && d.status !== 'closed'));
      setTasks(Array.isArray(taskRes) ? taskRes : taskRes.tasks?.filter((t: Task) => t.backend_status !== 'completed') ?? []);
      setRecs(recRes);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const items = useMemo<PriorityItem[]>(() => {
    const all: PriorityItem[] = [];

    for (const ob of obligations) {
      all.push({
        id: `ob-${ob.id}`,
        kind: 'obligation',
        title: ob.payee,
        subtitle: ob.category + (ob.subcategory ? ` · ${ob.subcategory}` : ''),
        amount: ob.amount_due,
        dueDate: ob.due_date,
        daysLeft: ob.due_date ? daysUntil(ob.due_date) : null,
        urgencyScore: ob.urgency_score,
        priority: ob.urgency_score ? (ob.urgency_score >= 70 ? 1 : ob.urgency_score >= 50 ? 2 : ob.urgency_score >= 30 ? 3 : 4) : 4,
        status: ob.status,
        quadrant: classifyObligation(ob),
      });
    }

    for (const d of disputes) {
      all.push({
        id: `disp-${d.id}`,
        kind: 'dispute',
        title: d.title,
        subtitle: `${d.counterparty} · ${d.dispute_type}`,
        amount: d.amount_at_stake,
        dueDate: d.next_action_date,
        daysLeft: d.next_action_date ? daysUntil(d.next_action_date) : null,
        urgencyScore: null,
        priority: d.priority,
        status: d.status,
        quadrant: classifyDispute(d),
      });
    }

    for (const t of tasks) {
      all.push({
        id: `task-${t.id}`,
        kind: 'task',
        title: t.title,
        subtitle: t.task_type + (t.source ? ` · ${t.source}` : ''),
        amount: null,
        dueDate: t.due_date,
        daysLeft: t.due_date ? daysUntil(t.due_date) : null,
        urgencyScore: null,
        priority: t.priority,
        status: t.backend_status,
        quadrant: classifyTask(t),
      });
    }

    for (const r of recs) {
      all.push({
        id: `rec-${r.id}`,
        kind: 'recommendation',
        title: r.title,
        subtitle: r.rec_type + (r.obligation_payee ? ` · ${r.obligation_payee}` : '') + (r.dispute_title ? ` · ${r.dispute_title}` : ''),
        amount: null,
        dueDate: null,
        daysLeft: null,
        urgencyScore: null,
        priority: r.priority,
        status: 'active',
        quadrant: classifyRecommendation(r),
      });
    }

    return all.sort((a, b) => a.priority - b.priority);
  }, [obligations, disputes, tasks, recs]);

  const grouped = useMemo(() => {
    const result: Record<Quadrant, PriorityItem[]> = {
      do_first: [],
      schedule: [],
      delegate: [],
      eliminate: [],
    };
    for (const item of items) {
      result[item.quadrant].push(item);
    }
    return result;
  }, [items]);

  if (loading) {
    return (
      <div className="eisenhower-loading">
        <Crosshair size={32} className="eisenhower-loading-icon" />
        <p>Mapping priority matrix...</p>
      </div>
    );
  }

  return (
    <div className="eisenhower-root">
      {/* Header */}
      <div className="eisenhower-header">
        <div className="eisenhower-header-left">
          <Crosshair size={20} className="eisenhower-header-icon" />
          <div>
            <h1 className="eisenhower-title">Priority Matrix</h1>
            <p className="eisenhower-subtitle">
              {items.length} items across {obligations.length} bills, {disputes.length} disputes, {tasks.length} tasks, {recs.length} recs
            </p>
          </div>
        </div>
        <button onClick={load} className="eisenhower-refresh" title="Reload">
          <RefreshCw size={16} />
        </button>
      </div>

      {error && (
        <div className="eisenhower-error">
          <AlertTriangle size={14} />
          <span>{error}</span>
        </div>
      )}

      {/* Quadrant count chips */}
      <div className="eisenhower-chips">
        {(['do_first', 'schedule', 'delegate', 'eliminate'] as Quadrant[]).map((q) => {
          const meta = QUADRANTS[q];
          const Icon = meta.icon;
          return (
            <div key={q} className={`eisenhower-chip ${meta.cssClass}`}>
              <Icon size={12} />
              <span className="eisenhower-chip-label">{meta.label}</span>
              <span className="eisenhower-chip-count">{grouped[q].length}</span>
            </div>
          );
        })}
      </div>

      {/* Matrix grid */}
      <div className="eisenhower-grid">
        {/* Axis labels */}
        <div className="eisenhower-axis-y">
          <span className="eisenhower-axis-label eisenhower-axis-label--top">IMPORTANT</span>
          <span className="eisenhower-axis-label eisenhower-axis-label--bottom">NOT IMPORTANT</span>
        </div>
        <div className="eisenhower-axis-x">
          <span className="eisenhower-axis-label">URGENT</span>
          <span className="eisenhower-axis-label">NOT URGENT</span>
        </div>

        {/* Crosshair center */}
        <div className="eisenhower-crosshair-h" />
        <div className="eisenhower-crosshair-v" />
        <div className="eisenhower-crosshair-dot" />

        {/* Q1 — Do First (top-left) */}
        <QuadrantPanel quadrant="do_first" items={grouped.do_first} position="tl" />
        {/* Q2 — Schedule (top-right) */}
        <QuadrantPanel quadrant="schedule" items={grouped.schedule} position="tr" />
        {/* Q3 — Delegate (bottom-left) */}
        <QuadrantPanel quadrant="delegate" items={grouped.delegate} position="bl" />
        {/* Q4 — Eliminate (bottom-right) */}
        <QuadrantPanel quadrant="eliminate" items={grouped.eliminate} position="br" />
      </div>
    </div>
  );
}

// ── Quadrant panel component ─────────────────────────────────

function QuadrantPanel({ quadrant, items, position }: { quadrant: Quadrant; items: PriorityItem[]; position: string }) {
  const meta = QUADRANTS[quadrant];
  const Icon = meta.icon;

  return (
    <div className={`eisenhower-quadrant eisenhower-quadrant--${position} ${meta.cssClass}`}>
      <div className="eisenhower-quadrant-header">
        <Icon size={14} />
        <span className="eisenhower-quadrant-label">{meta.label}</span>
        <span className="eisenhower-quadrant-tactical">{meta.tactical}</span>
        {items.length > 0 && (
          <span className="eisenhower-quadrant-count">{items.length}</span>
        )}
      </div>
      <div className="eisenhower-quadrant-list">
        {items.length === 0 ? (
          <div className="eisenhower-empty">All clear</div>
        ) : (
          items.map((item, idx) => (
            <PriorityRow key={item.id} item={item} index={idx} />
          ))
        )}
      </div>
    </div>
  );
}

// ── Individual priority item row ─────────────────────────────

function PriorityRow({ item, index }: { item: PriorityItem; index: number }) {
  const KindIcon = KIND_ICON[item.kind];
  const overdue = item.daysLeft !== null && item.daysLeft < 0;
  const dueSoon = item.daysLeft !== null && item.daysLeft >= 0 && item.daysLeft <= 3;

  return (
    <div
      className="eisenhower-row"
      style={{ animationDelay: `${index * 40}ms` }}
    >
      <div className="eisenhower-row-icon" title={KIND_LABEL[item.kind]}>
        <KindIcon size={13} />
      </div>
      <div className="eisenhower-row-body">
        <div className="eisenhower-row-title">{item.title}</div>
        {item.subtitle && (
          <div className="eisenhower-row-subtitle">{item.subtitle}</div>
        )}
      </div>
      <div className="eisenhower-row-meta">
        {item.amount && (
          <span className="eisenhower-row-amount">{formatCurrency(item.amount)}</span>
        )}
        {item.dueDate && (
          <span className={`eisenhower-row-date ${overdue ? 'eisenhower-row-date--overdue' : dueSoon ? 'eisenhower-row-date--soon' : ''}`}>
            {overdue ? `${Math.abs(item.daysLeft!)}d late` : item.daysLeft === 0 ? 'Today' : item.daysLeft !== null && item.daysLeft <= 14 ? `${item.daysLeft}d` : formatDate(item.dueDate)}
          </span>
        )}
      </div>
    </div>
  );
}
