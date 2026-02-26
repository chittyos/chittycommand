import { NavLink } from 'react-router-dom';
import { cn } from '../lib/utils';
import { LayoutDashboard, Zap, Receipt, ShieldAlert, Wallet, Settings } from 'lucide-react';

const navItems = [
  { path: '/', label: 'Home', icon: LayoutDashboard },
  { path: '/queue', label: 'Queue', icon: Zap },
  { path: '/bills', label: 'Bills', icon: Receipt },
  { path: '/disputes', label: 'Disputes', icon: ShieldAlert },
  { path: '/accounts', label: 'Accounts', icon: Wallet },
  { path: '/settings', label: 'Settings', icon: Settings },
];

export function MobileNav() {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-30 bg-chrome-surface border-t border-chrome-border lg:hidden pb-safe">
      <div className="flex items-center justify-around h-14">
        {navItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === '/'}
            className={({ isActive }) =>
              cn(
                'flex flex-col items-center justify-center gap-0.5 px-3 py-1 min-w-[3rem] transition-colors',
                isActive ? 'text-chitty-500' : 'text-chrome-muted',
              )
            }
          >
            <item.icon size={20} />
            <span className="text-[10px] font-medium">{item.label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
