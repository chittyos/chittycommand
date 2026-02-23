import { useState, useCallback } from 'react';
import { api } from '../lib/api';

interface PlaidLinkProps {
  onSuccess: (itemId: string, accountsLinked: number) => void;
}

/**
 * Plaid Link integration.
 * Loads the Plaid Link drop-in via script tag — no npm dependency needed.
 * Flow: get link_token → open Plaid Link → exchange public_token → accounts created.
 */
export function PlaidLink({ onSuccess }: PlaidLinkProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ itemId: string; count: number } | null>(null);

  const openPlaid = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      // 1. Get link token from our backend
      const { link_token } = await api.getPlaidLinkToken();

      // 2. Load Plaid Link script if not already loaded
      await loadPlaidScript();

      // 3. Open Plaid Link
      const handler = (window as any).Plaid.create({
        token: link_token,
        onSuccess: async (publicToken: string, metadata: any) => {
          try {
            // 4. Exchange token and link accounts
            const exchangeResult = await api.exchangePlaidToken(publicToken);
            setResult({ itemId: exchangeResult.item_id, count: exchangeResult.accounts_linked });
            onSuccess(exchangeResult.item_id, exchangeResult.accounts_linked);
          } catch (e: any) {
            setError(`Token exchange failed: ${e.message}`);
          } finally {
            setLoading(false);
          }
        },
        onExit: (err: any) => {
          if (err) setError(`Plaid Link error: ${err.error_message || err.display_message || 'Unknown'}`);
          setLoading(false);
        },
      });

      handler.open();
    } catch (e: any) {
      setError(e.message);
      setLoading(false);
    }
  }, [onSuccess]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <button
          onClick={openPlaid}
          disabled={loading}
          className="px-4 py-2 bg-chitty-600 text-white rounded-lg hover:bg-chitty-700 disabled:opacity-50 transition-colors text-sm font-medium"
        >
          {loading ? 'Connecting...' : 'Connect Bank Account'}
        </button>
        {result && (
          <span className="text-green-400 text-sm">
            Linked {result.count} account{result.count !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {error && (
        <div className="text-red-400 text-sm bg-red-900/20 rounded p-2 border border-red-800">
          {error}
        </div>
      )}

      <p className="text-gray-500 text-xs">
        Securely connect your bank via Plaid. Credentials are never stored — only a read-only access token.
      </p>
    </div>
  );
}

/** Load the Plaid Link script dynamically */
function loadPlaidScript(): Promise<void> {
  if ((window as any).Plaid) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Plaid Link script'));
    document.head.appendChild(script);
  });
}
