import { useRef, useCallback, useEffect } from 'react';

interface SwipeCallbacks {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  onSwipeUp?: () => void;
  onMove?: (dx: number, dy: number) => void;
  onEnd?: () => void;
  threshold?: number;
  velocityThreshold?: number;
}

export function useSwipeGesture(callbacks: SwipeCallbacks) {
  const ref = useRef<HTMLDivElement>(null);
  const startX = useRef(0);
  const startY = useRef(0);
  const startTime = useRef(0);
  const tracking = useRef(false);

  const threshold = callbacks.threshold ?? 80;
  const velocityThreshold = callbacks.velocityThreshold ?? 0.5;

  const handleStart = useCallback((clientX: number, clientY: number) => {
    startX.current = clientX;
    startY.current = clientY;
    startTime.current = Date.now();
    tracking.current = true;
  }, []);

  const handleMove = useCallback((clientX: number, clientY: number) => {
    if (!tracking.current) return;
    const dx = clientX - startX.current;
    const dy = clientY - startY.current;
    callbacks.onMove?.(dx, dy);
  }, [callbacks]);

  const handleEnd = useCallback((clientX: number, clientY: number) => {
    if (!tracking.current) return;
    tracking.current = false;

    const dx = clientX - startX.current;
    const dy = clientY - startY.current;
    const dt = (Date.now() - startTime.current) / 1000;
    const velocity = Math.sqrt(dx * dx + dy * dy) / dt;

    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    const meetsThreshold = absDx > threshold || absDy > threshold || velocity > velocityThreshold * 1000;

    if (meetsThreshold) {
      if (absDx > absDy) {
        // Horizontal swipe
        if (dx > 0) callbacks.onSwipeRight?.();
        else callbacks.onSwipeLeft?.();
      } else {
        // Vertical swipe
        if (dy < 0) callbacks.onSwipeUp?.();
      }
    }

    callbacks.onEnd?.();
  }, [callbacks, threshold, velocityThreshold]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      handleStart(t.clientX, t.clientY);
    };
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      handleMove(t.clientX, t.clientY);
    };
    const onTouchEnd = (e: TouchEvent) => {
      const t = e.changedTouches[0];
      handleEnd(t.clientX, t.clientY);
    };

    const onMouseDown = (e: MouseEvent) => handleStart(e.clientX, e.clientY);
    const onMouseMove = (e: MouseEvent) => handleMove(e.clientX, e.clientY);
    const onMouseUp = (e: MouseEvent) => handleEnd(e.clientX, e.clientY);

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('mousedown', onMouseDown);
    el.addEventListener('mousemove', onMouseMove);
    el.addEventListener('mouseup', onMouseUp);

    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('mousedown', onMouseDown);
      el.removeEventListener('mousemove', onMouseMove);
      el.removeEventListener('mouseup', onMouseUp);
    };
  }, [handleStart, handleMove, handleEnd]);

  return ref;
}
