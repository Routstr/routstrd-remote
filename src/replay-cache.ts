import { assertNip98Fresh } from "./nip98";

export const DEFAULT_REPLAY_CACHE_MAX = 16384;
const RETENTION_SECONDS = 125;

export function parseReplayCacheMax(value?: string): number {
  if (value === undefined) return DEFAULT_REPLAY_CACHE_MAX;
  if (!/^[1-9]\d*$/.test(value) || Number(value) > 1_000_000) {
    throw new Error("ROUTSTRD_AUTH_REPLAY_CACHE_MAX must be an integer from 1 to 1000000.");
  }
  return Number(value);
}

export class ReplayError extends Error {
  constructor(
    public readonly code: "nip98_replayed" | "replay_cache_saturated",
    public readonly retryAfter = 0,
  ) {
    super(code === "nip98_replayed"
      ? "NIP-98 event has already been used."
      : "NIP-98 replay cache is at capacity. Try again later.");
  }
}

/** Nondecreasing wall time shared by freshness checks and cache expiry.
 * A backwards adjustment freezes logical time until wall time catches up;
 * a forward jump expires old events permanently within this proxy instance.
 */
export function nondecreasingClock(wallNow: () => number): () => number {
  let latest = -Infinity;
  return () => {
    const wall = wallNow();
    if (!Number.isFinite(wall)) throw new Error("Invalid authentication clock.");
    latest = Math.max(latest, Math.round(wall / 1000));
    return latest;
  };
}

/** Per-proxy, insertion-ordered expiry queue and ID index in one Map.
 * Fixed retention and nondecreasing time make expiry order insertion order.
 * Cleanup visits only expired entries plus the first live entry, amortized O(1).
 */
export class ReplayCache {
  private readonly entries = new Map<string, number>();
  private lastWarning = -Infinity;

  constructor(private readonly max: number, private readonly now: () => number) {
    if (!Number.isInteger(max) || max < 1 || max > 1_000_000) {
      throw new Error("Invalid replay cache capacity.");
    }
  }

  consume(event: { id: string; created_at: number }): void {
    const now = this.now();
    // Recheck after asynchronous body hashing and authorization, before admission.
    assertNip98Fresh(event.created_at, now);
    for (const [id, expiry] of this.entries) {
      if (expiry > now) break;
      this.entries.delete(id);
    }
    if (this.entries.has(event.id)) throw new ReplayError("nip98_replayed");
    if (this.entries.size >= this.max) {
      if (now - this.lastWarning >= 60) {
        console.warn(`NIP-98 replay cache saturated (capacity ${this.max}); refusing new requests.`);
        this.lastWarning = now;
      }
      const expiry = this.entries.values().next().value!;
      throw new ReplayError("replay_cache_saturated", Math.max(1, expiry - now));
    }
    this.entries.set(event.id, now + RETENTION_SECONDS);
  }
}
