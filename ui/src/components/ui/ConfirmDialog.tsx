import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ActionButton } from './ActionButton';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'primary' | 'danger';
  loading?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'primary',
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !loading) {
        onCancel();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [loading, onCancel, open]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => !loading && onCancel()}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="relative w-full max-w-md rounded-2xl border border-card-border bg-card-bg shadow-2xl p-5"
      >
        <h2 id="confirm-dialog-title" className="text-lg font-semibold text-card-text">
          {title}
        </h2>
        <p className="mt-2 text-sm text-card-muted whitespace-pre-wrap">{message}</p>
        <div className="mt-5 flex items-center justify-end gap-2">
          <ActionButton
            label={cancelLabel}
            variant="secondary"
            onClick={onCancel}
            disabled={loading}
          />
          <ActionButton
            label={confirmLabel}
            variant={variant}
            onClick={onConfirm}
            loading={loading}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

