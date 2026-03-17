import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi } from '../lib/api';
import { setToken, setUser } from '../lib/auth';
import { Lock, Shield, ChevronRight, AlertCircle } from 'lucide-react';

function useTypingEffect(text: string, speed = 40, startDelay = 600) {
  const [displayed, setDisplayed] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    setDisplayed('');
    setDone(false);
    const timeout = setTimeout(() => {
      let i = 0;
      const interval = setInterval(() => {
        setDisplayed(text.slice(0, i + 1));
        i++;
        if (i >= text.length) {
          clearInterval(interval);
          setDone(true);
        }
      }, speed);
      return () => clearInterval(interval);
    }, startDelay);
    return () => clearTimeout(timeout);
  }, [text, speed, startDelay]);

  return { displayed, done };
}

function GridBackground() {
  return (
    <div className="login-grid-bg" aria-hidden="true">
      <div className="login-grid-lines" />
      <div className="login-radial-glow" />
      <div className="login-scanline" />
      <div className="login-vignette" />
    </div>
  );
}

function StatusReadout() {
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const interval = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const utc = time.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  return (
    <div className="login-status-readout">
      <div className="login-status-item">
        <span className="login-status-dot login-status-dot--ok" />
        <span>SYS ONLINE</span>
      </div>
      <div className="login-status-item login-status-item--mono">
        {utc}
      </div>
      <div className="login-status-item">
        <span className="login-status-dot login-status-dot--ok" />
        <span>ENCRYPTED</span>
      </div>
    </div>
  );
}

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [mounted, setMounted] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const { displayed: subtitle, done: subtitleDone } = useTypingEffect(
    'Unified Command & Control Interface',
    35,
    800,
  );

  useEffect(() => {
    requestAnimationFrame(() => setMounted(true));
  }, []);

  useEffect(() => {
    if (subtitleDone && emailRef.current) {
      emailRef.current.focus();
    }
  }, [subtitleDone]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password || loading) return;
    setLoading(true);
    setError(null);
    try {
      const data = await authApi.login(email, password);
      setToken(data.token);
      setUser({ user_id: data.user_id, scopes: data.scopes });
      setSuccess(true);
      setTimeout(() => navigate('/'), 600);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-root">
      <GridBackground />

      <div className={`login-container ${mounted ? 'login-container--visible' : ''}`}>
        {/* Brand */}
        <div className="login-brand">
          <div className="login-logo-ring">
            <Shield size={28} strokeWidth={1.5} />
          </div>
          <h1 className="login-title">
            <span className="login-title-chitty">CHITTY</span>
            <span className="login-title-command">COMMAND</span>
          </h1>
          <div className="login-subtitle-wrap">
            <p className="login-subtitle">
              {subtitle}
              {!subtitleDone && <span className="login-cursor">|</span>}
            </p>
          </div>
        </div>

        {/* Card */}
        <div className={`login-card ${success ? 'login-card--success' : ''}`}>
          <div className="login-card-header">
            <Lock size={14} />
            <span>SECURE AUTHENTICATION</span>
          </div>

          {error && (
            <div className="login-error">
              <AlertCircle size={14} />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="login-form">
            <div className="login-field">
              <label htmlFor="login-email" className="login-label">OPERATOR ID</label>
              <input
                ref={emailRef}
                id="login-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="operator@chitty.cc"
                required
                autoComplete="email"
                className="login-input"
                disabled={loading || success}
              />
            </div>

            <div className="login-field">
              <label htmlFor="login-password" className="login-label">PASSPHRASE</label>
              <input
                id="login-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="&#x2022;&#x2022;&#x2022;&#x2022;&#x2022;&#x2022;&#x2022;&#x2022;&#x2022;&#x2022;&#x2022;&#x2022;"
                required
                autoComplete="current-password"
                className="login-input"
                disabled={loading || success}
              />
            </div>

            <button
              type="submit"
              disabled={loading || !email || !password || success}
              className="login-submit"
            >
              {success ? (
                <span className="login-submit-content">
                  <span className="login-submit-check">&#10003;</span>
                  ACCESS GRANTED
                </span>
              ) : loading ? (
                <span className="login-submit-content">
                  <span className="login-spinner" />
                  AUTHENTICATING
                </span>
              ) : (
                <span className="login-submit-content">
                  INITIATE SESSION
                  <ChevronRight size={16} />
                </span>
              )}
            </button>
          </form>

          <div className="login-footer">
            <span>ChittyOS Tier 5</span>
            <span className="login-footer-sep">&#x2022;</span>
            <span>Zero-Trust Auth</span>
            <span className="login-footer-sep">&#x2022;</span>
            <span>E2E Encrypted</span>
          </div>
        </div>

        <StatusReadout />
      </div>
    </div>
  );
}
