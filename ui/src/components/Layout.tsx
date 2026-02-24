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
