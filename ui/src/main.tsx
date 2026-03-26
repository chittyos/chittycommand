import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Dashboard } from './pages/Dashboard';
import { Bills } from './pages/Bills';
import { Disputes } from './pages/Disputes';
import { Accounts } from './pages/Accounts';
import { Legal } from './pages/Legal';
import { LitigationAssistant } from './pages/LitigationAssistant';
import { Upload } from './pages/Upload';
import { CashFlow } from './pages/CashFlow';
import { Recommendations } from './pages/Recommendations';
import { Settings } from './pages/Settings';
import { ActionQueue } from './pages/ActionQueue';
import { Evidence } from './pages/Evidence';
import { Tasks } from './pages/Tasks';
import { Login } from './pages/Login';
import { isAuthenticated } from './lib/auth';
import { ToastProvider } from './lib/toast';
import './index.css';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  if (!isAuthenticated()) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ToastProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/queue" element={<ActionQueue />} />
            <Route path="/bills" element={<Bills />} />
            <Route path="/disputes" element={<Disputes />} />
            <Route path="/accounts" element={<Accounts />} />
            <Route path="/legal" element={<Legal />} />
            <Route path="/litigation" element={<LitigationAssistant />} />
            <Route path="/recommendations" element={<Recommendations />} />
            <Route path="/cashflow" element={<CashFlow />} />
            <Route path="/evidence" element={<Evidence />} />
            <Route path="/tasks" element={<Tasks />} />
            <Route path="/upload" element={<Upload />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  </React.StrictMode>,
);
