import { useEffect, useId, useRef } from 'react';
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedElement = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return;

    previouslyFocusedElement.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (confirmButtonRef.current ?? cancelButtonRef.current)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !loading) {
        onCancel();
      }

      if (event.key === 'Tab' && dialogRef.current) {
        const focusable = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((el) => !el.hasAttribute('disabled'));

        if (focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (
        previouslyFocusedElement.current &&
        document.contains(previouslyFocusedElement.current)
      ) {
        previouslyFocusedElement.current.focus();
      }
    };
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
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="relative w-full max-w-md rounded-2xl border border-card-border bg-card-bg shadow-2xl p-5"
        ref={dialogRef}
      >
        <h2 id={titleId} className="text-lg font-semibold text-card-text">
          {title}
        </h2>
        <p
          id={descriptionId}
          className="mt-2 text-sm text-card-muted whitespace-pre-wrap"
        >
          {message}
        </p>
        <div className="mt-5 flex items-center justify-end gap-2">
          <ActionButton
            label={cancelLabel}
            variant="secondary"
            onClick={onCancel}
            disabled={loading}
            type="button"
            ref={cancelButtonRef}
          />
          <ActionButton
            label={confirmLabel}
            variant={variant}
            onClick={onConfirm}
            loading={loading}
            type="button"
            ref={confirmButtonRef}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
