import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type ServiceStatus, type Task } from '../lib/api';
import { ShieldCheck, ShieldAlert, Database, Activity, BookOpen } from 'lucide-react';

/**
 * AETHER is an OBSERVATION-ONLY projection. It does not attest Canon state,
 * authorize a tool call, issue capabilities, or bypass an executor.
 * ADR-0024 acceptance tests and external telemetry are not yet wired here.
 */
export function AetherGovernance() {
  const [services, setServices] = useState<ServiceStatus[] | null>(null);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [observedAt, setObservedAt] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const [serviceResult, taskResult] = await Promise.allSettled([
        api.getBridgeStatus(), api.getTasks({ limit: 100 }),
      ]);
      if (!active) return;
      const failures: string[] = [];
      if (serviceResult.status === 'fulfilled') setServices(serviceResult.value.services);
      else failures.push('Service connections unavailable');
      if (taskResult.status === 'fulfilled') setTasks(taskResult.value.tasks);
      else failures.push('Task feed unavailable');
      setErrors(failures);
      setObservedAt(new Date().toISOString());
      setLoading(false);
    };
    void load();
    return () => { active = false; };
  }, []);

  const connected = services?.filter((item) => item.status === 'ok').length ?? 0;
  const outstanding = tasks?.filter((task) => !['done', 'verified'].includes(task.backend_status)).length ?? 0;
  const panels = [
    {
      label: 'ChittyOS service connections',
      value: services === null ? 'Unavailable' : `${connected} / ${services.length} reporting OK`,
      detail: 'Existing bridge-status API. A healthy connection does not establish authorization.',
      icon: Activity,
    },
    {
      label: 'Tasks in returned page',
      value: tasks === null ? 'Unavailable' : String(tasks.length),
      detail: 'Read-only view of the first 100 tasks; not a complete event ledger.',
      icon: BookOpen,
    },
    {
      label: 'Non-terminal tasks in page',
      value: tasks === null ? 'Unavailable' : String(outstanding),
      detail: 'Status only. Completion or verification requires independently linked evidence.',
      icon: Database,
    },
  ];

  return (
    <div className="space-y-5 animate-fade-in-up">
      <div>
        <p className="text-xs uppercase tracking-widest text-chitty-500 font-semibold">AETHER / ADR-0024</p>
        <h1 className="font-display text-xl lg:text-2xl font-bold text-chrome-text mt-1">Governance Observation</h1>
        <p className="text-sm text-chrome-muted mt-2 max-w-3xl">
          Read-only projection of existing ChittyCommand services and tasks. No execution,
          approvals, cryptographic validation, epistemic promotion, or retrieval federation.
        </p>
      </div>

      <div className="rounded-xl border border-amber-400/40 bg-amber-500/10 p-4">
        <div className="flex items-center gap-2 font-semibold text-amber-600 text-sm">
          <ShieldAlert size={16} /> Safety assurance NOT VERIFIED
        </div>
        <p className="text-xs text-chrome-muted mt-2">
          ADR-0024 is an approved architectural design, not proof that Ed25519 capability checks,
          Canon revision pinning, per-person AI Search isolation, Ralph Loop stop hooks,
          fail-closed enforcement, or durable outbox execution have passed production tests.
          Control-plane write actions are intentionally absent.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {panels.map(({ label, value, detail, icon: Icon }) => (
          <section key={label} className="rounded-xl border border-chrome-border bg-chrome-surface p-4">
            <div className="flex items-center gap-2 text-xs text-chrome-muted"><Icon size={15} />{label}</div>
            <p className="text-xl font-bold text-chrome-text mt-3">{loading ? 'Loading' : value}</p>
            <p className="text-xs text-chrome-muted mt-2">{detail}</p>
          </section>
        ))}
      </div>

      {errors.length > 0 && (
        <div role="alert" className="rounded-xl border border-rose-500/40 p-4 text-sm text-rose-500">
          {errors.join('; ')}. Missing data is never treated as a passing check.
        </div>
      )}

      <section className="rounded-xl border border-chrome-border bg-chrome-surface p-4">
        <h2 className="font-semibold text-chrome-text flex items-center gap-2"><ShieldCheck size={16} /> Control contract</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs text-chrome-muted mt-4">
          <p><strong className="text-chrome-text">TY — identity:</strong> resolve a Canon P before a protected operation.</p>
          <p><strong className="text-chrome-text">VY — connectivity:</strong> service health is observational, not permission.</p>
          <p><strong className="text-chrome-text">RY — authority:</strong> real PEP verifies scoped capability before any side effect.</p>
          <p><strong className="text-chrome-text">Memory:</strong> per-P AI Search is an isolation target, not established by this page.</p>
          <p><strong className="text-chrome-text">Epistemics:</strong> retrieved material remains untrusted until independently verified.</p>
          <p><strong className="text-chrome-text">Ralph:</strong> bounded retry and stop hooks require executable proof, not UI simulation.</p>
        </div>
      </section>

      <p className="text-xs text-chrome-muted">
        Observation timestamp: {observedAt ?? 'Not available'} · Data originates from existing authenticated read APIs.
        For task details use the <Link to="/tasks" className="underline text-chitty-500">Task Board</Link>.
        This page does not claim an audit-grade or real-time telemetry stream.
      </p>
    </div>
  );
}
