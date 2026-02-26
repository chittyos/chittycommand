import { useState, useCallback } from 'react';
import { SwipeCard } from './SwipeCard';
import { useSwipeGesture } from '../../hooks/useSwipeGesture';
import type { QueueItem } from '../../lib/api';

interface SwipeStackProps {
  items: QueueItem[];
  onDecide: (id: string, decision: 'approved' | 'rejected' | 'deferred') => void;
  onLoadMore: () => void;
}

export function SwipeStack({ items, onDecide, onLoadMore }: SwipeStackProps) {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [exitDirection, setExitDirection] = useState<'left' | 'right' | 'up' | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  const currentItem = items[0];

  const handleDecision = useCallback((decision: 'approved' | 'rejected' | 'deferred') => {
    if (!currentItem) return;

    // Animate exit
    const dir = decision === 'approved' ? 'right' : decision === 'rejected' ? 'left' : 'up';
    setExitDirection(dir);

    setTimeout(() => {
      onDecide(currentItem.id, decision);
      setExitDirection(null);
      setOffset({ x: 0, y: 0 });
      setShowDetails(false);

      // Load more when stack gets low
      if (items.length <= 3) onLoadMore();
    }, 300);
  }, [currentItem, items.length, onDecide, onLoadMore]);

  const swipeRef = useSwipeGesture({
    onSwipeRight: () => handleDecision('approved'),
    onSwipeLeft: () => handleDecision('rejected'),
    onSwipeUp: () => handleDecision('deferred'),
    onMove: (dx, dy) => setOffset({ x: dx, y: dy }),
    onEnd: () => setOffset({ x: 0, y: 0 }),
    threshold: 80,
  });

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center">
        <p className="text-2xl font-semibold text-card-text">All caught up</p>
        <p className="text-card-muted mt-2">No pending actions. Run triage to generate new recommendations.</p>
      </div>
    );
  }

  // Exit animation transform
  const exitTransform = exitDirection === 'right'
    ? 'translate(120%, 0) rotate(20deg)'
    : exitDirection === 'left'
      ? 'translate(-120%, 0) rotate(-20deg)'
      : exitDirection === 'up'
        ? 'translate(0, -120%)'
        : undefined;

  return (
    <div className="relative w-full max-w-md mx-auto" style={{ minHeight: '420px' }}>
      {/* Background cards (peek) */}
      {items.slice(1, 3).map((item, i) => (
        <div
          key={item.id}
          className="absolute inset-x-0 top-0"
          style={{
            transform: `scale(${1 - (i + 1) * 0.04}) translateY(${(i + 1) * 8}px)`,
            zIndex: 10 - (i + 1),
            opacity: 1 - (i + 1) * 0.15,
            pointerEvents: 'none',
          }}
        >
          <div className="bg-card-bg border border-card-border rounded-2xl shadow-md p-5 sm:p-6">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{item.rec_type}</span>
            </div>
            <h3 className="text-lg font-semibold text-card-text truncate">{item.title}</h3>
          </div>
        </div>
      ))}

      {/* Active card */}
      <div
        ref={swipeRef}
        className="relative z-20"
        style={{
          transform: exitTransform,
          transition: exitDirection ? 'transform 0.3s ease-out, opacity 0.3s ease-out' : undefined,
          opacity: exitDirection ? 0 : 1,
        }}
      >
        <SwipeCard
          item={currentItem}
          offset={exitDirection ? { x: 0, y: 0 } : offset}
          showDetails={showDetails}
          onToggleDetails={() => setShowDetails((v) => !v)}
        />
      </div>

      {/* Card counter */}
      <div className="text-center mt-4">
        <span className="text-xs text-card-muted">{items.length} remaining</span>
      </div>
    </div>
  );
}
