import { cn } from '../../lib/utils';

interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return (
    <div className={cn('skeleton-shimmer rounded-lg', className)} />
  );
}

export function DashboardSkeleton() {
  return (
    <div className="space-y-4 lg:space-y-6 animate-fade-in">
      {/* Metric cards skeleton */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 lg:gap-3">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="glass-card rounded-card border p-3 lg:p-4" style={{ animationDelay: `${i * 80}ms` }}>
            <Skeleton className="h-3 w-16 mb-2" />
            <Skeleton className="h-7 w-24" />
          </div>
        ))}
      </div>

      {/* Widget skeletons */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6">
        {[1, 2].map((i) => (
          <div key={i} className="glass-card rounded-card border p-4 space-y-3">
            <Skeleton className="h-4 w-32" />
            {[1, 2, 3].map((j) => (
              <div key={j} className="flex items-center justify-between">
                <div className="space-y-1.5 flex-1">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-24" />
                </div>
                <Skeleton className="h-6 w-20" />
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6">
        {[1, 2].map((i) => (
          <div key={i} className="glass-card rounded-card border p-4 space-y-3">
            <Skeleton className="h-4 w-28" />
            {[1, 2].map((j) => (
              <div key={j} className="flex items-center justify-between">
                <div className="space-y-1.5 flex-1">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-3 w-32" />
                </div>
                <Skeleton className="h-5 w-12" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
