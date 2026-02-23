import { Outlet, NavLink } from 'react-router-dom';
import { cn } from '../lib/utils';
import { logout, getUser } from '../lib/auth';

const navItems = [
  { path: '/', label: 'Dashboard' },
  { path: '/bills', label: 'Bills' },
  { path: '/disputes', label: 'Disputes' },
  { path: '/accounts', label: 'Accounts' },
  { path: '/legal', label: 'Legal' },
  { path: '/recommendations', label: 'AI Recs' },
  { path: '/cashflow', label: 'Cash Flow' },
  { path: '/upload', label: 'Upload' },
  { path: '/settings', label: 'Settings' },
];

export function Layout() {
  const user = getUser();

  return (
    <div className="min-h-screen bg-[#0f1117]">
      <header className="border-b border-gray-800 bg-[#161822]">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <h1 className="text-xl font-bold text-white tracking-tight">
            ChittyCommand
          </h1>
          <div className="flex items-center gap-4">
            <nav className="flex gap-1">
              {navItems.map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  end={item.path === '/'}
                  className={({ isActive }) =>
                    cn(
                      'px-3 py-1.5 rounded text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-chitty-600 text-white'
                        : 'text-gray-400 hover:text-white hover:bg-gray-800'
                    )
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
            <div className="flex items-center gap-2 pl-3 border-l border-gray-700">
              {user && (
                <span className="text-gray-500 text-xs">{user.user_id}</span>
              )}
              <button
                onClick={logout}
                className="px-2 py-1 text-xs text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors"
              >
                Logout
              </button>
            </div>
          </div>
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
