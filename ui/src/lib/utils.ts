import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(value: string | number | null): string {
  if (value === null || value === undefined) return '$0.00';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(num);
}

export function formatDate(date: string): string {
  return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function daysUntil(date: string): number {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  return Math.floor((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

export function urgencyColor(score: number | null): string {
  if (!score) return 'text-gray-400';
  if (score >= 70) return 'text-red-400';
  if (score >= 50) return 'text-orange-400';
  if (score >= 30) return 'text-yellow-400';
  return 'text-green-400';
}

export function urgencyBg(score: number | null): string {
  if (!score) return 'bg-gray-800';
  if (score >= 70) return 'bg-red-900/30 border-red-700';
  if (score >= 50) return 'bg-orange-900/30 border-orange-700';
  if (score >= 30) return 'bg-yellow-900/30 border-yellow-700';
  return 'bg-green-900/30 border-green-700';
}

export function statusBadgeColor(status: string): string {
  switch (status) {
    case 'overdue': return 'bg-red-600';
    case 'pending': return 'bg-yellow-600';
    case 'paid': return 'bg-green-600';
    case 'disputed': return 'bg-purple-600';
    case 'deferred': return 'bg-gray-600';
    case 'open': return 'bg-red-600';
    case 'resolved': return 'bg-green-600';
    default: return 'bg-gray-600';
  }
}
