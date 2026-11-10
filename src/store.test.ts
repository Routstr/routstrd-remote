import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AuthStore } from "./store";
import { nip19 } from "nostr-tools";

// The hardcoded admin npub docker-entrypoint.sh used to default to.
const LEGACY_DEFAULT_ADMIN_PUBKEY =
  "fc76f8bdeeafc37a5a499b3a24064774d8a5a02c299a64aca072cf8c6c827b1f";
const ENV_ADMIN_A = "ab".repeat(32);
const ENV_ADMIN_B = "cd".repeat(32);
const API_NPUB = "ef".repeat(32);

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "routstrd-auth-store-test-"));
  tmpDirs.push(dir);
  return join(dir, "test.db");
}

describe("AuthStore env admin reconciliation", () => {
  it("bootstraps env admin pubkeys with source='env'", () => {
    const store = new AuthStore(tmpDbPath(), [ENV_ADMIN_A, ENV_ADMIN_B]);
    const npubs = store.listNpubs();
    expect(npubs.map((n) => n.pubkey).sort()).toEqual(
      [ENV_ADMIN_A, ENV_ADMIN_B].sort(),
    );
    for (const n of npubs) {
      expect(n.source).toBe("env");
      expect(n.role).toBe("admin");
    }
    store.close();
  });

  it("removes env-sourced npubs that are no longer in the env var", () => {
    const dbPath = tmpDbPath();
    new AuthStore(dbPath, [ENV_ADMIN_A, ENV_ADMIN_B]).close();

    const store = new AuthStore(dbPath, [ENV_ADMIN_A]);
    expect(store.hasNpub(ENV_ADMIN_A)).toBe(true);
    expect(store.hasNpub(ENV_ADMIN_B)).toBe(false);
    store.close();
  });

  it("purges the legacy hardcoded default admin when the env var is unset", () => {
    // Simulate an install that booted with the old baked-in default.
    const dbPath = tmpDbPath();
    new AuthStore(dbPath, [LEGACY_DEFAULT_ADMIN_PUBKEY]).close();

    const store = new AuthStore(dbPath, []);
    expect(store.hasNpub(LEGACY_DEFAULT_ADMIN_PUBKEY)).toBe(false);
    expect(store.countNpubs()).toBe(0);
    store.close();
  });

  it("never removes npubs registered via the API", () => {
    const dbPath = tmpDbPath();
    const first = new AuthStore(dbPath, [ENV_ADMIN_A]);
    first.addNpub(API_NPUB, "user", ENV_ADMIN_A);
    first.close();

    // Env var now unset: env row goes, API row stays.
    const store = new AuthStore(dbPath, []);
    expect(store.hasNpub(ENV_ADMIN_A)).toBe(false);
    const apiEntry = store.getNpubByPubkey(API_NPUB);
    expect(apiEntry?.source).toBe("api");
    expect(apiEntry?.role).toBe("user");
    store.close();
  });

  it("is case-insensitive when matching env pubkeys against stored rows", () => {
    const dbPath = tmpDbPath();
    new AuthStore(dbPath, [ENV_ADMIN_A.toLowerCase()]).close();

    const store = new AuthStore(dbPath, [ENV_ADMIN_A.toUpperCase()]);
    expect(store.hasNpub(ENV_ADMIN_A)).toBe(true);
    expect(store.countNpubs()).toBe(1);
    store.close();
  });
});

describe("AuthStore npub name field", () => {
  it("defaults name to null for newly added npubs", () => {
    const store = new AuthStore(tmpDbPath());
    const entry = store.addNpub(API_NPUB, "user", ENV_ADMIN_A);
    expect(entry.name).toBeNull();
    expect(store.getNpubByPubkey(API_NPUB)?.name).toBeNull();
    store.close();
  });

  it("stores and lists a name", () => {
    const store = new AuthStore(tmpDbPath());
    store.addNpub(API_NPUB, "user", ENV_ADMIN_A, "Alice");

    expect(store.getNpubByPubkey(API_NPUB)?.name).toBe("Alice");
    expect(store.listNpubs()[0]?.name).toBe("Alice");
    store.close();
  });

  it("lists only the npubs that have no display name", () => {
    const store = new AuthStore(tmpDbPath());
    store.addNpub(API_NPUB, "user", ENV_ADMIN_A, "Alice");
    store.addNpub("ab".repeat(32), "user", ENV_ADMIN_A);

    expect(store.listNpubs()).toHaveLength(2);
    expect(store.listUnnamedNpubs().map((entry) => entry.pubkey)).toEqual([
      "ab".repeat(32),
    ]);
    store.close();
  });

  it("updates a name and clears it with null", () => {
    const store = new AuthStore(tmpDbPath());
    store.addNpub(API_NPUB, "user", ENV_ADMIN_A, "Alice");

    const updated = store.updateNpubName(API_NPUB, "Bob");
    expect(updated?.name).toBe("Bob");
    expect(store.getNpubByPubkey(API_NPUB)?.name).toBe("Bob");

    const cleared = store.updateNpubName(API_NPUB, null);
    expect(cleared?.name).toBeNull();
    expect(store.getNpubByPubkey(API_NPUB)?.name).toBeNull();
    store.close();
  });

  it("updateNpub atomically updates role and name", () => {
    const store = new AuthStore(tmpDbPath());
    store.addNpub(API_NPUB, "user", ENV_ADMIN_A, "Alice");

    const updated = store.updateNpub(API_NPUB, { role: "admin", name: "Bob" });
    expect(updated?.role).toBe("admin");
    expect(updated?.name).toBe("Bob");

    const row = store.getNpubByPubkey(API_NPUB)!;
    expect(row.role).toBe("admin");
    expect(row.name).toBe("Bob");
    store.close();
  });

  it("updateNpub returns null for a missing npub", () => {
    const store = new AuthStore(tmpDbPath());
    expect(store.updateNpub(API_NPUB, { name: "x" })).toBeNull();
    store.close();
  });

  it("migrates an existing table without a name column", () => {
    const dbPath = tmpDbPath();
    const db = new Database(dbPath);
    db.run(`
      CREATE TABLE routstr_auth_npubs (
        pubkey TEXT PRIMARY KEY,
        npub TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        created_by TEXT,
        source TEXT NOT NULL DEFAULT 'api',
        role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'user'))
      )
    `);
    db.close();

    const store = new AuthStore(dbPath);
    store.addNpub(API_NPUB, "user", null, "Alice");
    expect(store.getNpubByPubkey(API_NPUB)?.name).toBe("Alice");
    store.close();
  });

  it("preserves existing row fields when migrating a table without a name column", () => {
    const dbPath = tmpDbPath();
    const db = new Database(dbPath);
    db.run(`
      CREATE TABLE routstr_auth_npubs (
        pubkey TEXT PRIMARY KEY,
        npub TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        created_by TEXT,
        source TEXT NOT NULL DEFAULT 'api',
        role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'user'))
      )
    `);
    db.run(
      `INSERT INTO routstr_auth_npubs (pubkey, npub, created_at, created_by, source, role)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [API_NPUB, nip19.npubEncode(API_NPUB), 123, "legacy", "api", "user"],
    );
    db.close();

    const store = new AuthStore(dbPath);
    const row = store.getNpubByPubkey(API_NPUB)!;
    expect(row.role).toBe("user");
    expect(row.name).toBeNull();
    expect(row.createdAt).toBe(123);
    expect(row.createdBy).toBe("legacy");
    expect(row.source).toBe("api");
    expect(row.npub).toBe(nip19.npubEncode(API_NPUB));
    store.close();
  });
});

// Usage summary forwarding tests:
// The auth proxy now forwards /usage and /usage/summary directly to the
// routstrd daemon with ?npub=<npub>. The daemon handles filtering, suffix
// stripping, and the full summary shape. Tests for getUsageSummary were
// removed from here — they live in the routstrd daemon's test suite.

describe("AuthStore monthly spend limits", () => {
  it("defaults the monthly limit to null (unlimited)", () => {
    const store = new AuthStore(tmpDbPath());
    const entry = store.addNpub(API_NPUB, "user");
    expect(entry.monthlyLimitSats).toBeNull();
    expect(store.getNpubByPubkey(API_NPUB)?.monthlyLimitSats).toBeNull();
    store.close();
  });

  it("stores, updates and clears a monthly limit", () => {
    const store = new AuthStore(tmpDbPath());
    store.addNpub(API_NPUB, "user", null, null, 5_000);
    expect(store.getNpubByPubkey(API_NPUB)?.monthlyLimitSats).toBe(5_000);

    expect(store.updateNpubMonthlyLimit(API_NPUB, 12_000)?.monthlyLimitSats).toBe(12_000);
    expect(store.listNpubs()[0]?.monthlyLimitSats).toBe(12_000);

    expect(store.updateNpubMonthlyLimit(API_NPUB, null)?.monthlyLimitSats).toBeNull();
    expect(store.getNpubByPubkey(API_NPUB)?.monthlyLimitSats).toBeNull();
    store.close();
  });

  it("keeps 0 sats as a real (blocking) limit, not as unlimited", () => {
    const store = new AuthStore(tmpDbPath());
    store.addNpub(API_NPUB, "user", null, null, 0);
    expect(store.getNpubByPubkey(API_NPUB)?.monthlyLimitSats).toBe(0);
    store.close();
  });

  it("migrates a legacy table without the monthly_limit_sats column", () => {
    const dbPath = tmpDbPath();
    const db = new Database(dbPath);
    db.run(`
      CREATE TABLE routstr_auth_npubs (
        pubkey TEXT PRIMARY KEY,
        npub TEXT NOT NULL UNIQUE,
        name TEXT,
        created_at INTEGER NOT NULL,
        created_by TEXT,
        source TEXT NOT NULL DEFAULT 'api',
        role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'user'))
      )
    `);
    db.run(
      `INSERT INTO routstr_auth_npubs (pubkey, npub, name, created_at, created_by, source, role)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [API_NPUB, nip19.npubEncode(API_NPUB), "Alice", 123, null, "api", "user"],
    );
    db.close();

    const store = new AuthStore(dbPath);
    const migrated = store.getNpubByPubkey(API_NPUB)!;
    expect(migrated.name).toBe("Alice");
    expect(migrated.monthlyLimitSats).toBeNull();

    expect(store.updateNpubMonthlyLimit(API_NPUB, 777)?.monthlyLimitSats).toBe(777);
    store.close();
  });
});

describe("AuthStore monthly usage", () => {
  /** Create a DB with the sdk_storage client list and a usage_tracking table. */
  function usageDb(rows: Array<{ client: string | null; sats: number; timestamp: number }>) {
    const dbPath = tmpDbPath();
    const db = new Database(dbPath);
    db.run("CREATE TABLE sdk_storage (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.run(`
      CREATE TABLE usage_tracking (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        client TEXT,
        sats_cost REAL NOT NULL
      )
    `);
    const insert = db.prepare(
      "INSERT INTO usage_tracking (id, timestamp, client, sats_cost) VALUES (?, ?, ?, ?)",
    );
    rows.forEach((row, index) => insert.run(`u${index}`, row.timestamp, row.client, row.sats));
    db.close();
    return dbPath;
  }

  function setClients(
    dbPath: string,
    clients: Array<{ clientId: string; ownerNpub?: string }>,
  ) {
    const db = new Database(dbPath);
    db.run("INSERT OR REPLACE INTO sdk_storage (key, value) VALUES ('client_ids', ?)", [
      JSON.stringify(
        clients.map((c, i) => ({
          clientId: c.clientId,
          name: c.clientId,
          apiKey: `sk-${i}`,
          createdAt: 0,
          lastUsed: null,
          ...(c.ownerNpub ? { ownerNpub: c.ownerNpub } : {}),
        })),
      ),
    ]);
    db.close();
  }

  it("throws when the daemon has not created usage_tracking yet", () => {
    const store = new AuthStore(tmpDbPath());
    expect(() => store.getMonthlyUsageByClient()).toThrow();
    expect(() => store.getMonthlyUsageByNpub()).toThrow();
    store.close();
  });

  it("sums only the current calendar month and groups by client", () => {
    const now = Date.now();
    const lastMonth = now - 40 * 24 * 60 * 60 * 1000;
    const dbPath = usageDb([
      { client: "alpha", sats: 10, timestamp: now },
      { client: "alpha", sats: 2.5, timestamp: now },
      { client: "beta", sats: 7, timestamp: now },
      { client: "alpha", sats: 1_000, timestamp: lastMonth },
    ]);
    const store = new AuthStore(dbPath);

    const usage = store.getMonthlyUsageByClient(now);
    expect(usage.get("alpha")).toBe(12.5);
    expect(usage.get("beta")).toBe(7);
    expect(usage.has("alpha") ? usage.get("alpha") : 0).toBeLessThan(1_000);
    store.close();
  });

  it("attributes usage to an npub through ownerNpub", () => {
    const now = Date.now();
    const dbPath = usageDb([
      { client: "pi-agent-abcdefg", sats: 100, timestamp: now },
      { client: "pi-agent-abcdefg", sats: 50, timestamp: now },
    ]);
    const store = new AuthStore(dbPath);
    store.addNpub(API_NPUB, "user");
    setClients(dbPath, [{ clientId: "pi-agent-abcdefg", ownerNpub: nip19.npubEncode(API_NPUB) }]);

    const usage = store.getMonthlyUsageByNpub(now);
    expect(usage.get(nip19.npubEncode(API_NPUB))).toBe(150);
    store.close();
  });

  it("attributes usage by the npub suffix when a client was deleted", () => {
    const now = Date.now();
    const npub = nip19.npubEncode(API_NPUB);
    const storedClientId = `pi-agent-${npub.slice(-7)}`;
    const dbPath = usageDb([{ client: storedClientId, sats: 42, timestamp: now }]);
    const store = new AuthStore(dbPath);
    store.addNpub(API_NPUB, "user");
    // No clients at all: the id still carries the npub suffix.
    setClients(dbPath, []);

    expect(store.getMonthlyUsageByNpub(now).get(npub)).toBe(42);
    store.close();
  });

  it("ignores usage that cannot be attributed to a registered npub", () => {
    const now = Date.now();
    const dbPath = usageDb([
      { client: "unknown-client", sats: 99, timestamp: now },
      { client: null, sats: 500, timestamp: now },
    ]);
    const store = new AuthStore(dbPath);
    store.addNpub(API_NPUB, "user");
    setClients(dbPath, []);

    expect(store.getMonthlyUsageByNpub(now).size).toBe(0);
    store.close();
  });
});
