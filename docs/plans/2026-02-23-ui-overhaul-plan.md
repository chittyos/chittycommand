# ChittyCommand UI Overhaul — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform ChittyCommand from a dark-theme developer dashboard into an ADHD-friendly "Command Console" with dark chrome shell, light card surfaces, Focus Mode, urgency-based hierarchy, and widget-based layout.

**Architecture:** Incremental replacement of existing UI. Theme foundation first, then shared components, then Layout shell, then Focus Mode, then page-by-page overhaul. Each task produces a working state — no broken intermediate builds.

**Tech Stack:** React 18, Tailwind CSS 3, Vite 5, react-grid-layout (new), recharts (new), Outfit + JetBrains Mono fonts (new), lucide-react (existing)

**Design Doc:** `docs/plans/2026-02-23-ui-overhaul-design.md`

---

### Task 1: Install Dependencies & Font Setup

**Files:**
- Modify: `ui/package.json`
- Modify: `ui/index.html`
- Modify: `ui/src/index.css`

**Step 1: Install new packages**

Run: `cd /Users/nb/Desktop/Projects/github.com/CHITTYOS/chittycommand/ui && npm install react-grid-layout recharts`
Run: `cd /Users/nb/Desktop/Projects/github.com/CHITTYOS/chittycommand/ui && npm install -D @types/react-grid-layout`

**Step 2: Add Google Fonts to index.html**

In `ui/index.html`, add to `<head>`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
```

**Step 3: Update index.css with new base styles**

Replace `ui/src/index.css` with:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  /* Chrome (dark shell) */
  --chrome-bg: #1a1a2e;
  --chrome-surface: #16213e;
  --chrome-border: #2a2a4a;
  --chrome-text: #e2e8f0;
  --chrome-text-muted: #94a3b8;

  /* Cards (light surfaces) */
  --card-bg: #ffffff;
  --card-bg-hover: #f8fafc;
  --card-border: #e2e8f0;
  --card-text: #1e293b;
  --card-text-muted: #64748b;

  /* Urgency */
  --urgency-red: #ef4444;
  --urgency-amber: #f59e0b;
  --urgency-green: #22c55e;
  --urgency-red-bg: #fef2f2;
  --urgency-amber-bg: #fffbeb;
  --urgency-green-bg: #f0fdf4;

  /* Brand */
  --chitty-500: #4c6ef5;
  --chitty-600: #3b5bdb;
  --chitty-700: #364fc7;
}

body {
  margin: 0;
  font-family: 'Outfit', -apple-system, BlinkMacSystemFont, sans-serif;
  background-color: var(--chrome-bg);
  color: var(--chrome-text);
  -webkit-font-smoothing: antialiased;
}

/* Monospace for financial numbers */
.font-mono {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
}

/* react-grid-layout overrides */
.react-grid-item.react-grid-placeholder {
  background: var(--chitty-500) !important;
  opacity: 0.15 !important;
  border-radius: 12px !important;
}
```

**Step 4: Verify build**

Run: `cd /Users/nb/Desktop/Projects/github.com/CHITTYOS/chittycommand/ui && npx vite build`
Expected: Build succeeds with no errors.

**Step 5: Commit**

```bash
git add ui/package.json ui/package-lock.json ui/index.html ui/src/index.css
git commit -m "feat(ui): add Outfit/JetBrains Mono fonts, recharts, react-grid-layout"
```

---

### Task 2: Tailwind Theme Config

**Files:**
- Modify: `ui/tailwind.config.js`

**Step 1: Replace tailwind.config.js**

```js
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Outfit', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      colors: {
        chitty: {
          50: '#f0f4ff',
          100: '#dbe4ff',
          500: '#4c6ef5',
          600: '#3b5bdb',
          700: '#364fc7',
          900: '#1b2559',
        },
        chrome: {
          bg: '#1a1a2e',
          surface: '#16213e',
          border: '#2a2a4a',
          text: '#e2e8f0',
          muted: '#94a3b8',
        },
        card: {
          bg: '#ffffff',
          hover: '#f8fafc',
          border: '#e2e8f0',
          text: '#1e293b',
          muted: '#64748b',
        },
        urgency: {
          red: '#ef4444',
          amber: '#f59e0b',
          green: '#22c55e',
        },
      },
      borderRadius: {
        card: '12px',
      },
    },
  },
  plugins: [],
};
```

**Step 2: Verify build**

Run: `cd /Users/nb/Desktop/Projects/github.com/CHITTYOS/chittycommand/ui && npx vite build`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add ui/tailwind.config.js
git commit -m "feat(ui): extend Tailwind theme with Command Console color system"
```

---

### Task 3: Shared UI Components

**Files:**
- Create: `ui/src/components/ui/Card.tsx`
- Create: `ui/src/components/ui/UrgencyBorder.tsx`
- Create: `ui/src/components/ui/FreshnessDot.tsx`
- Create: `ui/src/components/ui/ProgressDots.tsx`
- Create: `ui/src/components/ui/MetricCard.tsx`
- Create: `ui/src/components/ui/ActionButton.tsx`

**Step 1: Create Card component**

`ui/src/components/ui/Card.tsx`:

```tsx
import { cn } from '../../lib/utils';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  urgency?: 'red' | 'amber' | 'green' | null;
  muted?: boolean;
  onClick?: () => void;
}

export function Card({ children, className, urgency, muted, onClick }: CardProps) {
  const borderColor = urgency === 'red'
    ? 'border-l-urgency-red'
    : urgency === 'amber'
    ? 'border-l-urgency-amber'
    : urgency === 'green'
    ? 'border-l-urgency-green'
    : 'border-l-transparent';

  return (
    <div
      onClick={onClick}
      className={cn(
        'bg-card-bg rounded-card border border-card-border p-4 border-l-4 transition-shadow',
        borderColor,
        muted && 'opacity-60',
        onClick && 'cursor-pointer hover:shadow-md',
        className,
      )}
    >
      {children}
    </div>
  );
}
```

**Step 2: Create UrgencyBorder helper**

`ui/src/components/ui/UrgencyBorder.tsx`:

```tsx
export function urgencyLevel(score: number | null): 'red' | 'amber' | 'green' | null {
  if (score === null || score === undefined) return null;
  if (score >= 70) return 'red';
  if (score >= 40) return 'amber';
  return 'green';
}

export function urgencyFromDays(days: number): 'red' | 'amber' | 'green' {
  if (days <= 2) return 'red';
  if (days <= 7) return 'amber';
  return 'green';
}
```

**Step 3: Create FreshnessDot**

`ui/src/components/ui/FreshnessDot.tsx`:

```tsx
import { cn } from '../../lib/utils';

interface FreshnessDotProps {
  status: 'fresh' | 'stale' | 'failed' | 'unknown';
  className?: string;
}

export function FreshnessDot({ status, className }: FreshnessDotProps) {
  const color = status === 'fresh'
    ? 'bg-urgency-green'
    : status === 'stale'
    ? 'bg-urgency-amber'
    : status === 'failed'
    ? 'bg-urgency-red'
    : 'bg-chrome-muted';

  return <span className={cn('inline-block w-2 h-2 rounded-full', color, className)} />;
}

export function freshnessFromDate(dateStr: string | null): 'fresh' | 'stale' | 'failed' | 'unknown' {
  if (!dateStr) return 'unknown';
  const hours = (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60);
  if (hours < 24) return 'fresh';
  if (hours < 72) return 'stale';
  return 'failed';
}
```

**Step 4: Create ProgressDots**

`ui/src/components/ui/ProgressDots.tsx`:

```tsx
import { cn } from '../../lib/utils';

interface ProgressDotsProps {
  completed: number;
  total: number;
  className?: string;
}

export function ProgressDots({ completed, total, className }: ProgressDotsProps) {
  return (
    <div className={cn('flex items-center gap-1', className)}>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={cn(
            'w-2 h-2 rounded-full',
            i < completed ? 'bg-urgency-green' : 'bg-card-border',
          )}
        />
      ))}
      <span className="text-xs text-card-muted ml-1">
        {completed}/{total}
      </span>
    </div>
  );
}
```

**Step 5: Create MetricCard**

`ui/src/components/ui/MetricCard.tsx`:

```tsx
import { cn } from '../../lib/utils';

interface MetricCardProps {
  label: string;
  value: string;
  trend?: 'up' | 'down' | null;
  className?: string;
  valueClassName?: string;
}

export function MetricCard({ label, value, trend, className, valueClassName }: MetricCardProps) {
  return (
    <div className={cn('bg-card-bg rounded-card border border-card-border p-4', className)}>
      <p className="text-card-muted text-xs uppercase tracking-wider font-medium">{label}</p>
      <div className="flex items-baseline gap-1 mt-1">
        <p className={cn('text-2xl font-bold font-mono', valueClassName || 'text-card-text')}>{value}</p>
        {trend === 'up' && <span className="text-urgency-green text-sm">&#9650;</span>}
        {trend === 'down' && <span className="text-urgency-red text-sm">&#9660;</span>}
      </div>
    </div>
  );
}
```

**Step 6: Create ActionButton**

`ui/src/components/ui/ActionButton.tsx`:

```tsx
import { cn } from '../../lib/utils';

interface ActionButtonProps {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  loading?: boolean;
  disabled?: boolean;
  className?: string;
}

export function ActionButton({ label, onClick, variant = 'primary', loading, disabled, className }: ActionButtonProps) {
  const base = 'px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50';
  const variants = {
    primary: 'bg-chitty-600 text-white hover:bg-chitty-700',
    secondary: 'bg-card-border text-card-text hover:bg-gray-200',
    danger: 'bg-urgency-red text-white hover:bg-red-600',
  };

  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className={cn(base, variants[variant], className)}
    >
      {loading ? 'Working...' : label}
    </button>
  );
}
```

**Step 7: Verify build**

Run: `cd /Users/nb/Desktop/Projects/github.com/CHITTYOS/chittycommand/ui && npx vite build`
Expected: Build succeeds (components not yet used, but must compile).

**Step 8: Commit**

```bash
git add ui/src/components/ui/
git commit -m "feat(ui): add shared Card, MetricCard, urgency, freshness, progress components"
```

---

### Task 4: New Layout — Sidebar + Status Bar

**Files:**
- Modify: `ui/src/components/Layout.tsx`
- Create: `ui/src/components/Sidebar.tsx`
- Create: `ui/src/components/StatusBar.tsx`
- Create: `ui/src/lib/focus-mode.tsx`

**Step 1: Create FocusMode context**

`ui/src/lib/focus-mode.tsx`:

```tsx
import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

interface FocusModeContextType {
  focusMode: boolean;
  toggleFocusMode: () => void;
}

const FocusModeContext = createContext<FocusModeContextType>({
  focusMode: true,
  toggleFocusMode: () => {},
});

export function FocusModeProvider({ children }: { children: ReactNode }) {
  const [focusMode, setFocusMode] = useState(() => {
    const saved = localStorage.getItem('chittycommand_focus_mode');
    return saved !== null ? saved === 'true' : true; // default ON
  });

  const toggleFocusMode = useCallback(() => {
    setFocusMode((prev) => {
      const next = !prev;
      localStorage.setItem('chittycommand_focus_mode', String(next));
      return next;
    });
  }, []);

  return (
    <FocusModeContext.Provider value={{ focusMode, toggleFocusMode }}>
      {children}
    </FocusModeContext.Provider>
  );
}

export function useFocusMode() {
  return useContext(FocusModeContext);
}
```

**Step 2: Create Sidebar**

`ui/src/components/Sidebar.tsx`:

```tsx
import { NavLink } from 'react-router-dom';
import { cn } from '../lib/utils';
import {
  LayoutDashboard, Receipt, ShieldAlert, Wallet, Scale,
  Lightbulb, TrendingUp, Upload, Settings, LogOut,
} from 'lucide-react';
import { logout, getUser } from '../lib/auth';

const navItems = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/bills', label: 'Bills', icon: Receipt },
  { path: '/disputes', label: 'Disputes', icon: ShieldAlert },
  { path: '/accounts', label: 'Accounts', icon: Wallet },
  { path: '/legal', label: 'Legal', icon: Scale },
  { path: '/recommendations', label: 'AI Recs', icon: Lightbulb },
  { path: '/cashflow', label: 'Cash Flow', icon: TrendingUp },
  { path: '/upload', label: 'Upload', icon: Upload },
  { path: '/settings', label: 'Settings', icon: Settings },
];

export function Sidebar() {
  const user = getUser();

  return (
    <aside className="w-56 bg-chrome-surface border-r border-chrome-border flex flex-col h-screen sticky top-0">
      <div className="p-4 border-b border-chrome-border">
        <h1 className="text-lg font-bold text-white tracking-tight">ChittyCommand</h1>
      </div>

      <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
        {navItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === '/'}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                isActive
                  ? 'bg-chitty-600 text-white'
                  : 'text-chrome-muted hover:text-white hover:bg-chrome-border/50',
              )
            }
          >
            <item.icon size={18} />
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="p-3 border-t border-chrome-border">
        {user && (
          <p className="text-chrome-muted text-xs truncate mb-2">{user.user_id}</p>
        )}
        <button
          onClick={logout}
          className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-sm text-chrome-muted hover:text-white hover:bg-chrome-border/50 transition-colors"
        >
          <LogOut size={16} />
          Sign out
        </button>
      </div>
    </aside>
  );
}
```

**Step 3: Create StatusBar**

`ui/src/components/StatusBar.tsx`:

```tsx
import { useFocusMode } from '../lib/focus-mode';
import { Eye, EyeOff } from 'lucide-react';

interface StatusBarProps {
  cashPosition?: string;
  nextDue?: string;
}

export function StatusBar({ cashPosition, nextDue }: StatusBarProps) {
  const { focusMode, toggleFocusMode } = useFocusMode();

  return (
    <header className="h-12 bg-chrome-surface border-b border-chrome-border flex items-center justify-between px-4 sticky top-0 z-10">
      <div className="flex items-center gap-6 text-sm">
        {cashPosition && (
          <div className="flex items-center gap-2">
            <span className="text-chrome-muted">Cash</span>
            <span className="text-urgency-green font-mono font-semibold">{cashPosition}</span>
          </div>
        )}
        {nextDue && (
          <div className="flex items-center gap-2">
            <span className="text-chrome-muted">Next Due</span>
            <span className="text-chrome-text font-mono">{nextDue}</span>
          </div>
        )}
      </div>

      <button
        onClick={toggleFocusMode}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors bg-chrome-border/50 hover:bg-chrome-border text-chrome-text"
        title={focusMode ? 'Show full dashboard' : 'Focus on urgent items'}
      >
        {focusMode ? <Eye size={16} /> : <EyeOff size={16} />}
        {focusMode ? 'Focus' : 'Full View'}
      </button>
    </header>
  );
}
```

**Step 4: Rewrite Layout.tsx**

Replace `ui/src/components/Layout.tsx`:

```tsx
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { StatusBar } from './StatusBar';

export function Layout() {
  return (
    <div className="flex min-h-screen bg-chrome-bg">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <StatusBar />
        <main className="flex-1 p-6 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
```

**Step 5: Wrap app with FocusModeProvider**

In `ui/src/main.tsx`, wrap `<BrowserRouter>` with `<FocusModeProvider>`:

```tsx
import { FocusModeProvider } from './lib/focus-mode';

// Inside render:
<React.StrictMode>
  <FocusModeProvider>
    <BrowserRouter>
      {/* ... routes ... */}
    </BrowserRouter>
  </FocusModeProvider>
</React.StrictMode>
```

**Step 6: Verify build and visual**

Run: `cd /Users/nb/Desktop/Projects/github.com/CHITTYOS/chittycommand/ui && npx vite build`
Expected: Build succeeds. When running dev server, sidebar + status bar are visible. Pages still render but with old card colors (mixed state is OK — we'll fix pages next).

**Step 7: Commit**

```bash
git add ui/src/components/Layout.tsx ui/src/components/Sidebar.tsx ui/src/components/StatusBar.tsx ui/src/lib/focus-mode.tsx ui/src/main.tsx
git commit -m "feat(ui): new sidebar + status bar layout with Focus Mode context"
```

---

### Task 5: Dashboard Overhaul — Focus Mode + Full Mode

This is the biggest task. The Dashboard page gets completely rewritten with Focus Mode (default ON showing top 3 items) and Full Mode (dense widget grid).

**Files:**
- Modify: `ui/src/pages/Dashboard.tsx`
- Create: `ui/src/components/dashboard/FocusView.tsx`
- Create: `ui/src/components/dashboard/FullView.tsx`
- Create: `ui/src/components/dashboard/ObligationsWidget.tsx`
- Create: `ui/src/components/dashboard/DisputesWidget.tsx`
- Create: `ui/src/components/dashboard/DeadlinesWidget.tsx`
- Create: `ui/src/components/dashboard/RecommendationsWidget.tsx`

**Step 1: Create FocusView**

`ui/src/components/dashboard/FocusView.tsx`:

```tsx
import { Card } from '../ui/Card';
import { ActionButton } from '../ui/ActionButton';
import { urgencyLevel } from '../ui/UrgencyBorder';
import type { DashboardData, Obligation, Recommendation } from '../../lib/api';
import { formatCurrency, formatDate, daysUntil } from '../../lib/utils';

interface FocusViewProps {
  data: DashboardData;
  onPayNow: (ob: Obligation) => void;
  onExecute: (rec: Recommendation) => void;
  payingId: string | null;
  executingId: string | null;
}

interface FocusItem {
  type: 'obligation' | 'dispute' | 'deadline' | 'recommendation';
  urgency: number;
  title: string;
  subtitle: string;
  metric: string;
  action: { label: string; onClick: () => void; loading: boolean };
}

export function FocusView({ data, onPayNow, onExecute, payingId, executingId }: FocusViewProps) {
  const { obligations, disputes, deadlines, recommendations } = data;

  // Gather all items with urgency scores, pick top 3
  const items: FocusItem[] = [];

  obligations.urgent.forEach((ob) => {
    items.push({
      type: 'obligation',
      urgency: ob.urgency_score ?? 0,
      title: ob.payee,
      subtitle: ob.status === 'overdue'
        ? `OVERDUE ${Math.abs(daysUntil(ob.due_date))} days`
        : `Due ${formatDate(ob.due_date)}`,
      metric: formatCurrency(ob.amount_due),
      action: {
        label: 'Pay Now',
        onClick: () => onPayNow(ob),
        loading: payingId === ob.id,
      },
    });
  });

  disputes.forEach((d) => {
    items.push({
      type: 'dispute',
      urgency: (6 - d.priority) * 20, // P1 = 100, P2 = 80, etc.
      title: d.title,
      subtitle: `vs ${d.counterparty}`,
      metric: d.amount_at_stake ? formatCurrency(d.amount_at_stake) : '',
      action: {
        label: d.next_action ? 'Take Action' : 'View',
        onClick: () => window.location.href = '/disputes',
        loading: false,
      },
    });
  });

  deadlines.forEach((dl) => {
    const days = daysUntil(dl.deadline_date);
    items.push({
      type: 'deadline',
      urgency: dl.urgency_score ?? (days <= 7 ? 80 : 30),
      title: dl.title,
      subtitle: dl.case_ref,
      metric: days > 0 ? `${days}d left` : days === 0 ? 'TODAY' : `${Math.abs(days)}d ago`,
      action: {
        label: 'View',
        onClick: () => window.location.href = '/legal',
        loading: false,
      },
    });
  });

  recommendations.slice(0, 3).forEach((rec) => {
    items.push({
      type: 'recommendation',
      urgency: (6 - rec.priority) * 15,
      title: rec.title,
      subtitle: rec.reasoning,
      metric: '',
      action: {
        label: rec.action_type ? 'Execute' : 'View',
        onClick: () => rec.action_type ? onExecute(rec) : (window.location.href = '/recommendations'),
        loading: executingId === rec.id,
      },
    });
  });

  // Sort by urgency descending, take top 3
  const top3 = items.sort((a, b) => b.urgency - a.urgency).slice(0, 3);

  if (top3.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-2xl font-semibold text-card-text">All clear</p>
          <p className="text-card-muted mt-1">Nothing urgent right now.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      <p className="text-chrome-muted text-sm font-medium uppercase tracking-wider">Needs your attention</p>
      {top3.map((item, i) => (
        <Card
          key={i}
          urgency={urgencyLevel(item.urgency)}
          className="flex items-center justify-between gap-4"
        >
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-card-text truncate">{item.title}</p>
            <p className="text-card-muted text-sm mt-0.5">{item.subtitle}</p>
          </div>
          {item.metric && (
            <p className="text-lg font-bold font-mono text-card-text shrink-0">{item.metric}</p>
          )}
          <ActionButton
            label={item.action.label}
            onClick={item.action.onClick}
            loading={item.action.loading}
          />
        </Card>
      ))}
    </div>
  );
}
```

**Step 2: Create ObligationsWidget**

`ui/src/components/dashboard/ObligationsWidget.tsx`:

```tsx
import { Card } from '../ui/Card';
import { urgencyLevel } from '../ui/UrgencyBorder';
import type { Obligation } from '../../lib/api';
import { formatCurrency, formatDate, daysUntil } from '../../lib/utils';

interface Props {
  obligations: Obligation[];
  onPayNow: (ob: Obligation) => void;
  payingId: string | null;
}

export function ObligationsWidget({ obligations, onPayNow, payingId }: Props) {
  if (obligations.length === 0) {
    return (
      <div className="bg-card-bg rounded-card border border-card-border p-4">
        <h2 className="font-semibold text-card-text mb-2">Upcoming Bills</h2>
        <p className="text-card-muted text-sm text-center py-4">No pending obligations</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <h2 className="font-semibold text-chrome-text text-sm uppercase tracking-wider">Upcoming Bills</h2>
      {obligations.map((ob) => {
        const days = daysUntil(ob.due_date);
        return (
          <Card key={ob.id} urgency={urgencyLevel(ob.urgency_score)} muted={!ob.urgency_score || ob.urgency_score < 30}>
            <div className="flex items-center justify-between">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-card-text truncate">{ob.payee}</p>
                <p className="text-card-muted text-xs">
                  {ob.category} — {ob.status === 'overdue'
                    ? `${Math.abs(days)}d overdue`
                    : `Due ${formatDate(ob.due_date)}`}
                </p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <p className="font-mono font-semibold text-card-text">{formatCurrency(ob.amount_due)}</p>
                {ob.status !== 'paid' && (
                  <button
                    onClick={() => onPayNow(ob)}
                    disabled={payingId === ob.id}
                    className="px-3 py-1 text-xs font-medium bg-chitty-600 text-white rounded-lg hover:bg-chitty-700 disabled:opacity-50"
                  >
                    {payingId === ob.id ? '...' : 'Pay'}
                  </button>
                )}
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
```

**Step 3: Create DisputesWidget**

`ui/src/components/dashboard/DisputesWidget.tsx`:

```tsx
import { Card } from '../ui/Card';
import { ProgressDots } from '../ui/ProgressDots';
import type { Dispute } from '../../lib/api';
import { formatCurrency } from '../../lib/utils';

const DISPUTE_STAGES = ['filed', 'response_pending', 'in_review', 'resolved'];

function disputeStageIndex(status: string): number {
  const idx = DISPUTE_STAGES.indexOf(status);
  return idx >= 0 ? idx : 0;
}

interface Props {
  disputes: Dispute[];
}

export function DisputesWidget({ disputes }: Props) {
  if (disputes.length === 0) {
    return (
      <div className="bg-card-bg rounded-card border border-card-border p-4">
        <h2 className="font-semibold text-card-text mb-2">Active Disputes</h2>
        <p className="text-card-muted text-sm text-center py-4">No active disputes</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <h2 className="font-semibold text-chrome-text text-sm uppercase tracking-wider">Active Disputes</h2>
      {disputes.map((d) => (
        <Card key={d.id} urgency={d.priority <= 1 ? 'red' : d.priority <= 3 ? 'amber' : 'green'}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="font-medium text-card-text truncate">{d.title}</p>
              <p className="text-card-muted text-xs">vs {d.counterparty}</p>
              <ProgressDots completed={disputeStageIndex(d.status) + 1} total={DISPUTE_STAGES.length} className="mt-2" />
            </div>
            <div className="text-right shrink-0">
              {d.amount_at_stake && (
                <p className="font-mono font-semibold text-urgency-red">{formatCurrency(d.amount_at_stake)}</p>
              )}
              {d.next_action && (
                <a href="/disputes" className="text-xs text-chitty-500 hover:underline mt-1 block">{d.next_action}</a>
              )}
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
```

**Step 4: Create DeadlinesWidget**

`ui/src/components/dashboard/DeadlinesWidget.tsx`:

```tsx
import { Card } from '../ui/Card';
import { urgencyFromDays } from '../ui/UrgencyBorder';
import type { LegalDeadline } from '../../lib/api';
import { formatDate, daysUntil } from '../../lib/utils';

interface Props {
  deadlines: LegalDeadline[];
}

export function DeadlinesWidget({ deadlines }: Props) {
  if (deadlines.length === 0) return null;

  return (
    <div className="space-y-2">
      <h2 className="font-semibold text-chrome-text text-sm uppercase tracking-wider">Legal Deadlines</h2>
      {deadlines.map((dl) => {
        const days = daysUntil(dl.deadline_date);
        return (
          <Card key={dl.id} urgency={urgencyFromDays(days)}>
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-card-text">{dl.title}</p>
                <p className="text-card-muted text-xs">{dl.case_ref}</p>
              </div>
              <div className="text-right">
                <p className="font-mono font-semibold text-card-text">
                  {days > 0 ? `${days}d` : days === 0 ? 'TODAY' : `${Math.abs(days)}d ago`}
                </p>
                <p className="text-card-muted text-xs">{formatDate(dl.deadline_date)}</p>
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
```

**Step 5: Create RecommendationsWidget**

`ui/src/components/dashboard/RecommendationsWidget.tsx`:

```tsx
import { Card } from '../ui/Card';
import { ActionButton } from '../ui/ActionButton';
import type { Recommendation } from '../../lib/api';

interface Props {
  recommendations: Recommendation[];
  onExecute: (rec: Recommendation) => void;
  executingId: string | null;
}

export function RecommendationsWidget({ recommendations, onExecute, executingId }: Props) {
  if (recommendations.length === 0) return null;

  return (
    <div className="space-y-2">
      <h2 className="font-semibold text-chrome-text text-sm uppercase tracking-wider">AI Recommendations</h2>
      {recommendations.map((rec) => (
        <Card key={rec.id} urgency={rec.priority <= 2 ? 'amber' : null}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-chitty-600 text-white">{rec.rec_type}</span>
              </div>
              <p className="font-medium text-card-text">{rec.title}</p>
              <p className="text-card-muted text-xs mt-0.5 line-clamp-2">{rec.reasoning}</p>
            </div>
            {rec.action_type && (
              <ActionButton
                label="Execute"
                onClick={() => onExecute(rec)}
                loading={executingId === rec.id}
                className="shrink-0"
              />
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}
```

**Step 6: Create FullView**

`ui/src/components/dashboard/FullView.tsx`:

```tsx
import { MetricCard } from '../ui/MetricCard';
import { ObligationsWidget } from './ObligationsWidget';
import { DisputesWidget } from './DisputesWidget';
import { DeadlinesWidget } from './DeadlinesWidget';
import { RecommendationsWidget } from './RecommendationsWidget';
import type { DashboardData, Obligation, Recommendation } from '../../lib/api';
import { formatCurrency } from '../../lib/utils';

interface FullViewProps {
  data: DashboardData;
  onPayNow: (ob: Obligation) => void;
  onExecute: (rec: Recommendation) => void;
  payingId: string | null;
  executingId: string | null;
}

export function FullView({ data, onPayNow, onExecute, payingId, executingId }: FullViewProps) {
  const { summary, obligations, disputes, deadlines, recommendations } = data;

  return (
    <div className="space-y-6">
      {/* Summary Metrics */}
      <div className="grid grid-cols-4 gap-3">
        <MetricCard label="Cash Available" value={formatCurrency(summary.total_cash)} valueClassName="text-urgency-green" />
        <MetricCard label="Credit Owed" value={formatCurrency(summary.total_credit_owed)} valueClassName="text-urgency-red" />
        <MetricCard label="Due Next 30d" value={formatCurrency(obligations.total_due_30d)} valueClassName="text-urgency-amber" />
        <MetricCard
          label="Overdue"
          value={obligations.overdue_count}
          valueClassName={Number(obligations.overdue_count) > 0 ? 'text-urgency-red' : 'text-urgency-green'}
        />
      </div>

      {/* Two-column widget grid */}
      <div className="grid grid-cols-2 gap-6">
        <ObligationsWidget obligations={obligations.urgent} onPayNow={onPayNow} payingId={payingId} />
        <DisputesWidget disputes={disputes} />
      </div>

      <div className="grid grid-cols-2 gap-6">
        <DeadlinesWidget deadlines={deadlines} />
        <RecommendationsWidget recommendations={recommendations} onExecute={onExecute} executingId={executingId} />
      </div>
    </div>
  );
}
```

**Step 7: Rewrite Dashboard.tsx**

Replace `ui/src/pages/Dashboard.tsx`:

```tsx
import { useEffect, useState, useCallback } from 'react';
import { api, type DashboardData, type Obligation, type Recommendation } from '../lib/api';
import { useFocusMode } from '../lib/focus-mode';
import { FocusView } from '../components/dashboard/FocusView';
import { FullView } from '../components/dashboard/FullView';

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [executingId, setExecutingId] = useState<string | null>(null);
  const { focusMode } = useFocusMode();

  const reload = useCallback(() => {
    api.getDashboard().then(setData).catch((e) => setError(e.message));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const handlePayNow = async (ob: Obligation) => {
    if (payingId) return;
    setPayingId(ob.id);
    try {
      await api.markPaid(ob.id);
      reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Payment failed');
    } finally {
      setPayingId(null);
    }
  };

  const handleExecute = async (rec: Recommendation) => {
    if (executingId) return;
    setExecutingId(rec.id);
    try {
      await api.actOnRecommendation(rec.id, { action_taken: rec.action_type || 'executed' });
      reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Execution failed');
    } finally {
      setExecutingId(null);
    }
  };

  if (error && !data) {
    return (
      <div className="text-center py-20">
        <p className="text-urgency-red text-lg font-medium">Failed to load dashboard</p>
        <p className="text-card-muted mt-2">{error}</p>
      </div>
    );
  }

  if (!data) {
    return <div className="text-center py-20 text-chrome-muted">Loading...</div>;
  }

  const viewProps = { data, onPayNow: handlePayNow, onExecute: handleExecute, payingId, executingId };

  return focusMode ? <FocusView {...viewProps} /> : <FullView {...viewProps} />;
}
```

**Step 8: Verify build**

Run: `cd /Users/nb/Desktop/Projects/github.com/CHITTYOS/chittycommand/ui && npx vite build`
Expected: Build succeeds.

**Step 9: Commit**

```bash
git add ui/src/pages/Dashboard.tsx ui/src/components/dashboard/
git commit -m "feat(ui): dashboard overhaul with Focus Mode + full widget grid"
```

---

### Task 6: Bills Page Redesign

**Files:**
- Modify: `ui/src/pages/Bills.tsx`

**Step 1: Rewrite Bills.tsx**

Replace with card-based layout using new components. Key changes:
- Replace dark table with Card components per obligation
- Urgency left-border on each card
- Muted low-urgency items
- Keep filter buttons but restyle for light cards on dark chrome

```tsx
import { useEffect, useState } from 'react';
import { api, type Obligation } from '../lib/api';
import { Card } from '../components/ui/Card';
import { ActionButton } from '../components/ui/ActionButton';
import { urgencyLevel } from '../components/ui/UrgencyBorder';
import { formatCurrency, formatDate, daysUntil } from '../lib/utils';
import { cn } from '../lib/utils';

export function Bills() {
  const [obligations, setObligations] = useState<Obligation[]>([]);
  const [filter, setFilter] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [payingId, setPayingId] = useState<string | null>(null);

  useEffect(() => {
    const params: Record<string, string> = {};
    if (filter) params.status = filter;
    api.getObligations(params).then(setObligations).catch((e) => setError(e.message));
  }, [filter]);

  const handleMarkPaid = async (id: string) => {
    setPayingId(id);
    try {
      await api.markPaid(id);
      setObligations((prev) => prev.map((o) => (o.id === id ? { ...o, status: 'paid', urgency_score: 0 } : o)));
    } finally {
      setPayingId(null);
    }
  };

  if (error) return <p className="text-urgency-red">{error}</p>;

  const filters = ['', 'pending', 'overdue', 'paid'];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-chrome-text">Bills & Obligations</h1>
        <div className="flex gap-1">
          {filters.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
                filter === f
                  ? 'bg-chitty-600 text-white'
                  : 'bg-chrome-border/50 text-chrome-muted hover:text-white',
              )}
            >
              {f || 'All'}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        {obligations.map((ob) => {
          const days = ob.due_date ? daysUntil(ob.due_date) : null;
          return (
            <Card
              key={ob.id}
              urgency={urgencyLevel(ob.urgency_score)}
              muted={ob.status === 'paid' || (!ob.urgency_score || ob.urgency_score < 30)}
            >
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-card-text">{ob.payee}</p>
                  <p className="text-card-muted text-xs">
                    {ob.category}
                    {ob.due_date && (
                      <> — {days !== null && days < 0
                        ? <span className="text-urgency-red">{Math.abs(days)}d late</span>
                        : days === 0
                        ? <span className="text-urgency-amber">Due today</span>
                        : `Due ${formatDate(ob.due_date)}`
                      }</>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-4 shrink-0">
                  <p className="font-mono font-semibold text-card-text">{formatCurrency(ob.amount_due)}</p>
                  <span className={cn(
                    'text-xs px-2 py-0.5 rounded-full font-medium',
                    ob.status === 'paid' ? 'bg-green-100 text-green-700' :
                    ob.status === 'overdue' ? 'bg-red-100 text-red-700' :
                    ob.status === 'pending' ? 'bg-amber-100 text-amber-700' :
                    'bg-gray-100 text-gray-700',
                  )}>
                    {ob.status}
                  </span>
                  {ob.status !== 'paid' && (
                    <ActionButton
                      label="Mark Paid"
                      variant="secondary"
                      onClick={() => handleMarkPaid(ob.id)}
                      loading={payingId === ob.id}
                    />
                  )}
                </div>
              </div>
            </Card>
          );
        })}
        {obligations.length === 0 && (
          <p className="text-chrome-muted text-sm py-8 text-center">No obligations found</p>
        )}
      </div>
    </div>
  );
}
```

**Step 2: Verify build**

Run: `cd /Users/nb/Desktop/Projects/github.com/CHITTYOS/chittycommand/ui && npx vite build`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add ui/src/pages/Bills.tsx
git commit -m "feat(ui): redesign Bills page with urgency cards and ADHD-friendly layout"
```

---

### Task 7: Disputes Page Redesign

**Files:**
- Modify: `ui/src/pages/Disputes.tsx`

**Step 1: Rewrite Disputes.tsx with progress bars and one-action-per-card**

Key changes:
- Card component with urgency borders based on priority
- Progress bar showing dispute stage
- Single primary CTA per card
- Correspondence/documents behind expandable panel
- Use new Card, ProgressDots, ActionButton components

Keep the existing expand/collapse logic for correspondence and documents panels but restyle with light card surfaces.

**Step 2: Verify build**

Run: `cd /Users/nb/Desktop/Projects/github.com/CHITTYOS/chittycommand/ui && npx vite build`

**Step 3: Commit**

```bash
git add ui/src/pages/Disputes.tsx
git commit -m "feat(ui): redesign Disputes page with progress bars and one-action-per-card"
```

---

### Task 8: Accounts Page Redesign

**Files:**
- Modify: `ui/src/pages/Accounts.tsx`

**Step 1: Rewrite with new Card components**

Key changes:
- Group headers use chrome-text styling
- Account cards use Card component with light surfaces
- Credit utilization bar uses Tailwind classes matching new palette
- Balance text uses font-mono with urgency colors

**Step 2: Verify build and commit**

```bash
git add ui/src/pages/Accounts.tsx
git commit -m "feat(ui): redesign Accounts page with light cards and new color system"
```

---

### Task 9: CashFlow Page Redesign

**Files:**
- Modify: `ui/src/pages/CashFlow.tsx`

**Step 1: Replace custom bar chart with Recharts AreaChart**

Key changes:
- Use `recharts` `<AreaChart>` with fill gradient for cash flow projection
- Keep scenario panel but restyle with Card/MetricCard components
- Outflows table uses light card surface
- Restyle all buttons with ActionButton

**Step 2: Verify build and commit**

```bash
git add ui/src/pages/CashFlow.tsx
git commit -m "feat(ui): redesign CashFlow page with Recharts and new card system"
```

---

### Task 10: Remaining Pages — Settings, Login, Recommendations, Legal, Upload

**Files:**
- Modify: `ui/src/pages/Settings.tsx`
- Modify: `ui/src/pages/Login.tsx`
- Modify: `ui/src/pages/Recommendations.tsx`
- Modify: `ui/src/pages/Legal.tsx`
- Modify: `ui/src/pages/Upload.tsx`

**Step 1: Settings page**

Restyle all tables and panels with light card surfaces. Service cards use Card component. Sync status table uses Card-based rows.

**Step 2: Login page**

Dark background stays (login is outside Layout). Restyle form card with rounded-card, update input fields to use chrome colors, add Outfit font to title.

**Step 3: Recommendations page**

Use Card components with urgency borders. One CTA per card. Priority badges use pill style on light backgrounds.

**Step 4: Legal page**

Apply Card components with urgencyFromDays borders. Same pattern as DeadlinesWidget.

**Step 5: Upload page**

Restyle upload area with Card + dashed border on light surface.

**Step 6: Verify full build**

Run: `cd /Users/nb/Desktop/Projects/github.com/CHITTYOS/chittycommand/ui && npx vite build`
Expected: Clean build, no TypeScript errors.

**Step 7: Commit**

```bash
git add ui/src/pages/Settings.tsx ui/src/pages/Login.tsx ui/src/pages/Recommendations.tsx ui/src/pages/Legal.tsx ui/src/pages/Upload.tsx
git commit -m "feat(ui): redesign Settings, Login, Recommendations, Legal, Upload pages"
```

---

### Task 11: StatusBar Live Data + Polish

**Files:**
- Modify: `ui/src/components/Layout.tsx`
- Modify: `ui/src/components/StatusBar.tsx`

**Step 1: Pipe dashboard summary data into StatusBar**

The Layout component needs to fetch summary data and pass it to StatusBar. Add a lightweight API call in Layout that fetches `/api/dashboard` summary (cash position, next due date) and passes to StatusBar props.

**Step 2: Add freshness dots to StatusBar**

Add sync status freshness dots to the status bar — small colored dots per data source showing last sync freshness.

**Step 3: Verify and commit**

```bash
git add ui/src/components/Layout.tsx ui/src/components/StatusBar.tsx
git commit -m "feat(ui): wire live data into StatusBar with freshness indicators"
```

---

### Task 12: Final Visual Polish & Build Verification

**Files:**
- Various minor tweaks across all pages

**Step 1: Run full build**

Run: `cd /Users/nb/Desktop/Projects/github.com/CHITTYOS/chittycommand/ui && npx vite build`
Expected: Clean build.

**Step 2: Run dev server and visually verify each page**

Run: `cd /Users/nb/Desktop/Projects/github.com/CHITTYOS/chittycommand/ui && npx vite --host`

Verify:
- [ ] Login page renders with new styling
- [ ] Dashboard Focus Mode shows top 3 urgent items
- [ ] Focus Mode toggle switches to full view
- [ ] Full dashboard shows 4 metric cards + widget grid
- [ ] Bills page shows urgency-bordered cards
- [ ] Disputes page shows progress dots
- [ ] Accounts page shows grouped cards
- [ ] CashFlow page shows Recharts chart
- [ ] Settings page shows light card tables
- [ ] Sidebar navigation works for all routes
- [ ] Status bar shows cash position

**Step 3: Fix any visual issues found**

Address spacing, color, or typography inconsistencies.

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat(ui): Command Console visual polish and build verification"
```

---

### Dependency Graph

```
Task 1 (fonts/deps) ──┐
                       ├── Task 3 (shared components)
Task 2 (tailwind)  ────┘         │
                                 ├── Task 4 (layout + focus mode)
                                 │         │
                                 │         ├── Task 5 (dashboard)
                                 │         ├── Task 6 (bills)
                                 │         ├── Task 7 (disputes)
                                 │         ├── Task 8 (accounts)
                                 │         ├── Task 9 (cashflow)
                                 │         ├── Task 10 (remaining pages)
                                 │         └── Task 11 (statusbar data)
                                 │                    │
                                 │                    └── Task 12 (polish)
```

Tasks 5-10 can be parallelized (independent pages). Tasks 1-4 are sequential.
