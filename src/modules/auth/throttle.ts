import { clock } from '../../common/clock';

/**
 * Per-account failed-login throttle. In-memory: correct for a single API instance.
 * When running several API instances, move this state to a shared store (Redis or a
 * MongoDB collection) so limits apply across instances.
 */
const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;

const failures = new Map<string, { count: number; firstAt: number }>();

export function isAccountLocked(usernameNormalized: string): boolean {
  const f = failures.get(usernameNormalized);
  if (!f) return false;
  if (clock.now().getTime() - f.firstAt > WINDOW_MS) {
    failures.delete(usernameNormalized);
    return false;
  }
  return f.count >= MAX_FAILURES;
}

export function recordFailure(usernameNormalized: string): void {
  const now = clock.now().getTime();
  const f = failures.get(usernameNormalized);
  if (!f || now - f.firstAt > WINDOW_MS) failures.set(usernameNormalized, { count: 1, firstAt: now });
  else f.count += 1;
  if (failures.size > 50_000) failures.clear(); // bound memory under attack
}

export function clearFailures(usernameNormalized: string): void {
  failures.delete(usernameNormalized);
}

export function resetThrottle(): void {
  failures.clear();
}
