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
