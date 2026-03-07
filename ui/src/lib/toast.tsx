import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ToastViewport } from '../components/ui/Toast';

export type ToastVariant = 'success' | 'error' | 'info';

export interface ToastInput {
  title: string;
  description?: string;
  variant?: ToastVariant;
  durationMs?: number;
  actionLabel?: string;
  onAction?: () => void;
}

export interface ToastItem extends ToastInput {
  id: string;
  variant: ToastVariant;
  durationMs: number;
}

interface ToastContextType {
  showToast: (toast: ToastInput) => void;
  dismissToast: (id: string) => void;
  success: (title: string, description?: string, options?: Omit<ToastInput, 'title' | 'description' | 'variant'>) => void;
  error: (title: string, description?: string, options?: Omit<ToastInput, 'title' | 'description' | 'variant'>) => void;
  info: (title: string, description?: string, options?: Omit<ToastInput, 'title' | 'description' | 'variant'>) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const fallbackCounter = useRef(0);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismissToast = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback((toast: ToastInput) => {
    const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${fallbackCounter.current++}`;

    const nextToast: ToastItem = {
      ...toast,
      id,
      variant: toast.variant || 'info',
      durationMs: toast.durationMs ?? 5000,
    };

    setToasts((prev) => {
      const maxToasts = 4;
      const updated = [...prev, nextToast];
      const overflow = updated.length - maxToasts;

      if (overflow > 0) {
        const evicted = updated.slice(0, overflow);
        for (const toast of evicted) {
          const timer = timers.current.get(toast.id);
          if (timer) {
            clearTimeout(timer);
            timers.current.delete(toast.id);
          }
        }
        return updated.slice(overflow);
      }

      return updated;
    });

    if (nextToast.durationMs > 0) {
      const timer = setTimeout(() => {
        dismissToast(id);
      }, nextToast.durationMs);
      timers.current.set(id, timer);
    }
  }, [dismissToast]);

  useEffect(() => () => {
    for (const timer of timers.current.values()) {
      clearTimeout(timer);
    }
    timers.current.clear();
  }, []);

  const success = useCallback(
    (title: string, description?: string, options?: Omit<ToastInput, 'title' | 'description' | 'variant'>) => {
      showToast({ title, description, variant: 'success', ...options });
    },
    [showToast],
  );

  const error = useCallback(
    (title: string, description?: string, options?: Omit<ToastInput, 'title' | 'description' | 'variant'>) => {
      showToast({ title, description, variant: 'error', ...options });
    },
    [showToast],
  );

  const info = useCallback(
    (title: string, description?: string, options?: Omit<ToastInput, 'title' | 'description' | 'variant'>) => {
      showToast({ title, description, variant: 'info', ...options });
    },
    [showToast],
  );

  const value = useMemo(
    () => ({ showToast, dismissToast, success, error, info }),
    [dismissToast, error, info, showToast, success],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismissToast} />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
