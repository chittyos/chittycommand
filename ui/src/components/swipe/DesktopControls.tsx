interface DesktopControlsProps {
  onApprove: () => void;
  onReject: () => void;
  onDefer: () => void;
  disabled?: boolean;
}

export function DesktopControls({ onApprove, onReject, onDefer, disabled }: DesktopControlsProps) {
  return (
    <div className="hidden sm:flex items-center justify-center gap-4 mt-6">
      <button
        onClick={onReject}
        disabled={disabled}
        className="flex flex-col items-center gap-1 px-6 py-3 rounded-xl bg-red-50 border border-red-200 text-red-700 hover:bg-red-100 disabled:opacity-50 transition-colors"
      >
        <span className="text-2xl">&#10005;</span>
        <span className="text-xs font-medium">Reject</span>
        <kbd className="text-[10px] text-red-400 bg-red-100 px-1.5 py-0.5 rounded">&#8592; / R</kbd>
      </button>

      <button
        onClick={onDefer}
        disabled={disabled}
        className="flex flex-col items-center gap-1 px-6 py-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-700 hover:bg-amber-100 disabled:opacity-50 transition-colors"
      >
        <span className="text-2xl">&#8987;</span>
        <span className="text-xs font-medium">Defer</span>
        <kbd className="text-[10px] text-amber-400 bg-amber-100 px-1.5 py-0.5 rounded">&#8595; / D</kbd>
      </button>

      <button
        onClick={onApprove}
        disabled={disabled}
        className="flex flex-col items-center gap-1 px-6 py-3 rounded-xl bg-green-50 border border-green-200 text-green-700 hover:bg-green-100 disabled:opacity-50 transition-colors"
      >
        <span className="text-2xl">&#10003;</span>
        <span className="text-xs font-medium">Approve</span>
        <kbd className="text-[10px] text-green-400 bg-green-100 px-1.5 py-0.5 rounded">&#8594; / A</kbd>
      </button>
    </div>
  );
}
