import { NavLink } from 'react-router-dom';
import { cn } from '../lib/utils';
import {
  LayoutDashboard, Zap, Receipt, ShieldAlert, Wallet, Scale, Gavel,
  Lightbulb, TrendingUp, Upload, Settings, LogOut, BookOpen, ListChecks,
} from 'lucide-react';
import { logout, getUser } from '../lib/auth';

interface NavGroup {
  label?: string;
  items: { path: string; label: string; icon: typeof LayoutDashboard }[];
}

const navGroups: NavGroup[] = [
  {
    items: [
      { path: '/', label: 'Command Center', icon: LayoutDashboard },
    ],
  },
  {
    label: 'Money',
    items: [
      { path: '/bills', label: 'Bills', icon: Receipt },
      { path: '/accounts', label: 'Accounts', icon: Wallet },
      { path: '/cashflow', label: 'Cash Flow', icon: TrendingUp },
    ],
  },
  {
    label: 'Disputes',
    items: [
      { path: '/disputes', label: 'Active Disputes', icon: ShieldAlert },
      { path: '/legal', label: 'Legal Deadlines', icon: Scale },
      { path: '/litigation', label: 'Litigation AI', icon: Gavel },
      { path: '/evidence', label: 'Evidence Timeline', icon: BookOpen },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { path: '/queue', label: 'Action Queue', icon: Zap },
      { path: '/recommendations', label: 'AI Recs', icon: Lightbulb },
      { path: '/tasks', label: 'Task Board', icon: ListChecks },
    ],
  },
  {
    label: 'System',
    items: [
      { path: '/upload', label: 'Documents', icon: Upload },
      { path: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

export function Sidebar() {
  const user = getUser();

  return (
    <aside className="w-56 bg-chrome-surface border-r border-chrome-border flex flex-col h-screen sticky top-0">
      <div className="p-4 border-b border-chrome-border">
        <h1 className="font-display text-lg font-bold text-white tracking-tight">
          Chitty<span className="text-chitty-400">Command</span>
        </h1>
        <p className="text-chrome-muted text-[10px] uppercase tracking-[0.2em] mt-0.5 font-medium font-mono">Control Plane</p>
      </div>

      <nav className="flex-1 p-2 space-y-1 overflow-y-auto scrollbar-thin">
        {navGroups.map((group, gi) => (
          <div key={gi}>
            {group.label && (
              <p className="text-[9px] text-chrome-muted uppercase tracking-[0.2em] font-mono font-semibold px-3 pt-3 pb-1">
                {group.label}
              </p>
            )}
            {group.items.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.path === '/'}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-all duration-200',
                    isActive
                      ? 'nav-active text-white'
                      : 'text-chrome-muted hover:text-chrome-text hover:bg-chrome-border/40',
                  )
                }
              >
                <item.icon size={16} />
                {item.label}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      <div className="p-3 border-t border-chrome-border">
        {user && (
          <p className="text-chrome-muted text-[10px] font-mono truncate mb-2 opacity-60">{user.user_id}</p>
        )}
        <button
          onClick={logout}
          className="flex items-center gap-2 w-full px-3 py-2 rounded-xl text-sm text-chrome-muted hover:text-chrome-text hover:bg-chrome-border/40 transition-all duration-200"
        >
          <LogOut size={14} />
          Sign out
        </button>
      </div>
    </aside>
  );
}
