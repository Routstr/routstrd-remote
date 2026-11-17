import { describe, expect, it, spyOn } from "bun:test";
import { ReplayCache, ReplayError, nondecreasingClock, parseReplayCacheMax } from "./replay-cache";
import { validateNIP98Request } from "./nip98";
import { finalizeEvent, generateSecretKey } from "nostr-tools";

describe("replay cache", () => {
  it("validates a bounded positive integer capacity", () => {
    expect(parseReplayCacheMax()).toBe(16384);
    expect(parseReplayCacheMax("1")).toBe(1);
    expect(parseReplayCacheMax("1000000")).toBe(1000000);
    for (const value of ["", "0", "-1", "1.5", "NaN", "Infinity", "1000001", "1e3", " 12"]) {
      expect(() => parseReplayCacheMax(value)).toThrow();
    }
  });

  it("never evicts live IDs, reports capacity and expires after the inclusive validity boundary", () => {
    let now = 1000;
    const cache = new ReplayCache(1, () => now);
    const event = { id: "a", created_at: 1060 };
    cache.consume(event);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let i = 0; i < 2; i++) {
        try {
          cache.consume({ id: "b", created_at: now });
          throw new Error("expected saturation");
        } catch (err) {
          expect(err).toBeInstanceOf(ReplayError);
          expect((err as ReplayError).code).toBe("replay_cache_saturated");
          expect((err as ReplayError).retryAfter).toBe(125);
        }
      }
      expect(warn).toHaveBeenCalledTimes(1);
      now = 1120;
      expect(() => cache.consume(event)).toThrow("already been used");
      now = 1125;
      cache.consume({ id: "b", created_at: now });
      expect(() => cache.consume(event)).toThrow("outside the allowed window");
    } finally { warn.mockRestore(); }
  });

  it("does not consume stale requests and recovers after a long idle gap", () => {
    let now = 1000;
    const cache = new ReplayCache(1, () => now);
    expect(() => cache.consume({ id: "old", created_at: 900 })).toThrow();
    cache.consume({ id: "a", created_at: now });
    now += 100000;
    cache.consume({ id: "b", created_at: now });
  });

  it("shares nondecreasing time with freshness across rollback and forward jumps", () => {
    let wall = 1000000;
    const now = nondecreasingClock(() => wall);
    const cache = new ReplayCache(1, now);
    const event = { id: "a", created_at: 1000 };
    cache.consume(event);
    wall -= 30000;
    expect(now()).toBe(1000);
    expect(() => cache.consume(event)).toThrow("already been used");
    wall += 200000;
    cache.consume({ id: "b", created_at: now() });
    wall = 1000000;
    expect(() => cache.consume(event)).toThrow("outside the allowed window");
  });

  it("rechecks freshness after asynchronous payload hashing", async () => {
    const body = new TextEncoder().encode("{}");
    const hash = Buffer.from(await crypto.subtle.digest("SHA-256", body)).toString("hex");
    const event = finalizeEvent({ kind: 27235, created_at: 1000, content: "", tags: [
      ["u", "https://app.example/npubs"], ["method", "POST"], ["payload", hash],
    ] }, generateSecretKey());
    let reads = 0;
    await expect(validateNIP98Request(`Nostr ${btoa(JSON.stringify(event))}`,
      new Request("https://app.example/npubs", { method: "POST", body }), body,
      undefined, () => reads++ === 0 ? 1000 : 1061)).rejects.toThrow("outside the allowed window");
  });
});
