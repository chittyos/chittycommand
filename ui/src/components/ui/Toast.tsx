import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { ToastItem } from '../../lib/toast';

interface ToastViewportProps {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}

const toastVariants: Record<ToastItem['variant'], { icon: typeof CheckCircle2; className: string }> = {
  success: {
    icon: CheckCircle2,
    className: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  },
  error: {
    icon: AlertCircle,
    className: 'border-rose-200 bg-rose-50 text-rose-900',
  },
  info: {
    icon: Info,
    className: 'border-indigo-200 bg-indigo-50 text-indigo-900',
  },
};

export function ToastViewport({ toasts, onDismiss }: ToastViewportProps) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-[100] w-full max-w-md -translate-x-1/2 px-4 pointer-events-none">
      <div className="space-y-2">
        {toasts.map((toast) => {
          const variant = toastVariants[toast.variant];
          const Icon = variant.icon;

          return (
            <div
              key={toast.id}
              className={cn(
                'pointer-events-auto rounded-xl border shadow-lg backdrop-blur-sm px-3 py-2 animate-fade-in-up',
                variant.className,
              )}
              role="status"
              aria-live="polite"
            >
              <div className="flex items-start gap-2">
                <Icon size={16} className="mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold leading-tight">{toast.title}</p>
                  {toast.description && (
                    <p className="text-xs mt-0.5 opacity-90">{toast.description}</p>
                  )}
                  {toast.actionLabel && toast.onAction && (
                    <button
                      type="button"
                      onClick={() => {
                        toast.onAction?.();
                        onDismiss(toast.id);
                      }}
                      className="mt-1.5 text-xs font-semibold underline underline-offset-2"
                    >
                      {toast.actionLabel}
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => onDismiss(toast.id)}
                  className="opacity-70 hover:opacity-100 transition-opacity"
                  aria-label="Dismiss notification"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
