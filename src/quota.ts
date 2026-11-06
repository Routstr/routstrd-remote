/**
 * Calendar-month boundaries for per-npub spend limits.
 *
 * Limits reset at the start of the month in the server's local timezone. The
 * Cloudron image runs with the platform timezone (usually UTC); set `TZ` to
 * move the reset to another local midnight.
 */
export function monthStart(now: number = Date.now()): number {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

export function nextMonthStart(now: number = Date.now()): number {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime();
}

/** Unix seconds until the next reset, for the `Retry-After` header. */
export function secondsUntilNextMonth(now: number = Date.now()): number {
  return Math.max(1, Math.ceil((nextMonthStart(now) - now) / 1000));
}
