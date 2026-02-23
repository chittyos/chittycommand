import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi } from '../lib/api';
import { setToken, setUser } from '../lib/auth';

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    setLoading(true);
    setError(null);
    try {
      const data = await authApi.login(email, password);
      setToken(data.token);
      setUser({ user_id: data.user_id, scopes: data.scopes });
      navigate('/');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0f1117] flex items-center justify-center">
      <div className="w-full max-w-sm">
        <div className="bg-[#161822] rounded-lg border border-gray-800 p-8">
          <h1 className="text-2xl font-bold text-white text-center mb-1">ChittyCommand</h1>
          <p className="text-gray-500 text-sm text-center mb-6">Sign in to your command center</p>

          {error && (
            <div className="mb-4 p-3 rounded bg-red-900/30 border border-red-800 text-red-400 text-sm">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm text-gray-400 mb-1">Email</label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@chitty.cc"
                required
                className="w-full bg-[#0f1117] border border-gray-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-chitty-500"
              />
            </div>
            <div>
              <label htmlFor="password" className="block text-sm text-gray-400 mb-1">Password</label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                className="w-full bg-[#0f1117] border border-gray-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-chitty-500"
              />
            </div>
            <button
              type="submit"
              disabled={loading || !email || !password}
              className="w-full py-2 bg-chitty-600 text-white rounded font-medium hover:bg-chitty-700 transition-colors disabled:opacity-50"
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
