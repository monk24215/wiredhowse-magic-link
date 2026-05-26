// Maps prior login count (logins before this one) to session duration in seconds.
// Login 1  (0 prior)   → 2h  | Logins 2-4  (1-3 prior) → 4h
// Logins 5-7 (4-6 prior) → 6h | Logins 8+  (7+ prior)  → 12h
export function loginTierDuration(priorLoginCount: number): number {
  if (priorLoginCount === 0) return 2 * 3600;
  if (priorLoginCount <= 3) return 4 * 3600;
  if (priorLoginCount <= 6) return 6 * 3600;
  return 12 * 3600;
}
