import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatRelativeTime(iso: string, locale?: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const isZh = (locale ?? '').toLowerCase().startsWith('zh');
  const diffMs = Date.now() - then;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return isZh ? '刚刚' : 'just now';
  if (minutes < 60) return isZh ? `${minutes}分钟前` : `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return isZh ? `${hours}小时前` : `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return isZh ? `${days}天前` : `${days} d ago`;
}
