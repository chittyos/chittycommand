import { useState, useCallback, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { MobileNav } from './MobileNav';
import { StatusBar } from './StatusBar';
import { Menu, X } from 'lucide-react';

export function Layout() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();

  // Close drawer on navigation
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  const toggleDrawer = useCallback(() => setDrawerOpen((p) => !p), []);

  return (
    <div className="flex min-h-screen bg-chrome-bg">
      {/* Desktop sidebar — hidden on mobile */}
      <div className="hidden lg:block">
        <Sidebar />
      </div>

      {/* Mobile drawer overlay */}
      {drawerOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setDrawerOpen(false)}
        />
      )}

      {/* Mobile drawer */}
      <div
        className={`fixed inset-y-0 left-0 z-50 w-64 transform transition-transform duration-200 ease-out lg:hidden ${
          drawerOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <Sidebar />
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile header */}
        <header className="lg:hidden flex items-center justify-between h-14 px-4 bg-chrome-surface border-b border-chrome-border sticky top-0 z-30">
          <button
            onClick={toggleDrawer}
            className="p-2 -ml-2 text-chrome-muted hover:text-white transition-colors"
            aria-label={drawerOpen ? 'Close menu' : 'Open menu'}
          >
            {drawerOpen ? <X size={22} /> : <Menu size={22} />}
          </button>
          <h1 className="text-base font-bold text-white tracking-tight">ChittyCommand</h1>
          <div className="w-8" /> {/* Spacer for centering */}
        </header>

        <StatusBar />

        <main className="flex-1 p-4 lg:p-6 overflow-y-auto pb-20 lg:pb-6">
          <Outlet />
        </main>

        {/* Mobile bottom nav — hidden on desktop */}
        <MobileNav />
      </div>
    </div>
  );
}
