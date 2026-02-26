import { useEffect } from 'react';

interface KeyboardActions {
  onApprove?: () => void;
  onReject?: () => void;
  onDefer?: () => void;
  onToggleDetails?: () => void;
  enabled?: boolean;
}

export function useKeyboardShortcuts(actions: KeyboardActions) {
  useEffect(() => {
    if (actions.enabled === false) return;

    const handler = (e: KeyboardEvent) => {
      // Don't capture when typing in inputs
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      switch (e.key) {
        case 'ArrowRight':
        case 'a':
          e.preventDefault();
          actions.onApprove?.();
          break;
        case 'ArrowLeft':
        case 'r':
          e.preventDefault();
          actions.onReject?.();
          break;
        case 'ArrowDown':
        case 'd':
          e.preventDefault();
          actions.onDefer?.();
          break;
        case ' ':
          e.preventDefault();
          actions.onToggleDetails?.();
          break;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [actions]);
}
