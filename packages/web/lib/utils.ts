import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merges Tailwind CSS class names. Wraps clsx + twMerge so conflicting
 * classes are deduplicated correctly (e.g. `cn('p-4', 'p-2')` → `'p-2'`).
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
