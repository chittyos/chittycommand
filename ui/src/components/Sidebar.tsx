import { NavLink } from 'react-router-dom';
import { cn } from '../lib/utils';
import {
  LayoutDashboard, Zap, Receipt, ShieldAlert, Wallet, Scale,
  Lightbulb, TrendingUp, Upload, Settings, LogOut,
} from 'lucide-react';
import { logout, getUser } from '../lib/auth';

const navItems = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/queue', label: 'Action Queue', icon: Zap },
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
        <h1 className="font-display text-lg font-bold text-white tracking-tight">
          Chitty<span className="text-chitty-400">Command</span>
        </h1>
        <p className="text-chrome-muted text-[10px] uppercase tracking-[0.2em] mt-0.5 font-medium">Control Plane</p>
      </div>

      <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto scrollbar-thin">
        {navItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === '/'}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200',
                isActive
                  ? 'nav-active text-white'
                  : 'text-chrome-muted hover:text-chrome-text hover:bg-chrome-border/40',
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
          <p className="text-chrome-muted text-xs font-mono truncate mb-2 opacity-60">{user.user_id}</p>
        )}
        <button
          onClick={logout}
          className="flex items-center gap-2 w-full px-3 py-2 rounded-xl text-sm text-chrome-muted hover:text-chrome-text hover:bg-chrome-border/40 transition-all duration-200"
        >
          <LogOut size={16} />
          Sign out
        </button>
      </div>
    </aside>
  );
}
