import { Database } from "bun:sqlite";
import { nip19 } from "nostr-tools";

export interface Client {
  clientId: string;
  name: string;
  apiKey: string;
  createdAt: number;
  lastUsed: number | null;
  ownerNpub?: string;
}

export type NpubRole = "admin" | "user";

export interface NpubEntry {
  pubkey: string;
  npub: string;
  name: string | null;
  createdAt: number;
  createdBy: string | null;
  source: string;
  role: NpubRole;
}

/**
 * Thin wrapper around the shared routstrd SQLite DB.
 *
 * Client API keys are read from routstrd's sdk_storage key-value table.
 * Registered npubs (admin and user) are stored in a dedicated table in the same DB.
 */
export class AuthStore {
  private db: Database;

  constructor(dbPath: string, bootstrapAdminPubkeys: string[] = []) {
    this.db = new Database(dbPath);
    this.migrateNpubTable();
    this.reconcileEnvAdminPubkeys(bootstrapAdminPubkeys);
  }

  /**
   * Creates the npubs table and migrates legacy admin data if present.
   * Handles the rename from routstr_auth_admins → routstr_auth_npubs with
   * a new `role` column (legacy admins become 'admin' role).
   */
  private migrateNpubTable(): void {
    this.db.transaction(() => {
      // Create the new table.
      this.db.run(`
        CREATE TABLE IF NOT EXISTS routstr_auth_npubs (
          pubkey TEXT PRIMARY KEY,
          npub TEXT NOT NULL UNIQUE,
          name TEXT,
          created_at INTEGER NOT NULL,
          created_by TEXT,
          source TEXT NOT NULL DEFAULT 'api',
          role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'user'))
        )
      `);

      // Migrate: add name column if it doesn't exist (older DBs won't have it).
      const cols = this.db
        .query("PRAGMA table_info(routstr_auth_npubs)")
        .all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "name")) {
        this.db.run("ALTER TABLE routstr_auth_npubs ADD COLUMN name TEXT");
      }

      // Check if the legacy table exists and migrate its data.
      const legacyExists = this.db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='routstr_auth_admins'")
        .get();

      if (legacyExists) {
        this.db.run(`
          INSERT OR IGNORE INTO routstr_auth_npubs (pubkey, npub, name, created_at, created_by, source, role)
          SELECT pubkey, npub, NULL, created_at, created_by, source, 'admin' FROM routstr_auth_admins
        `);
        this.db.run(`DROP TABLE routstr_auth_admins`);
      }
    })();
  }

  /**
   * Bootstrap env-provided admin pubkeys and delete `source='env'` rows no
   * longer present in the env — otherwise removing a pubkey from the variable
   * would leave it admin forever. `source='api'` rows are never touched.
   */
  private reconcileEnvAdminPubkeys(pubkeys: string[]): void {
    const uniquePubkeys = [...new Set(pubkeys.map((p) => p.toLowerCase()))];
    const keep = new Set(uniquePubkeys);
    const now = Math.floor(Date.now() / 1000);

    this.db.transaction(() => {
      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO routstr_auth_npubs
          (pubkey, npub, created_at, created_by, source, role)
        VALUES
          (?, ?, ?, NULL, 'env', 'admin')
      `);
      for (const pubkey of uniquePubkeys) {
        insert.run(pubkey, nip19.npubEncode(pubkey), now);
      }

      const envRows = this.db
        .query("SELECT pubkey FROM routstr_auth_npubs WHERE source = 'env'")
        .all() as Array<{ pubkey: string }>;
      const remove = this.db.prepare(
        "DELETE FROM routstr_auth_npubs WHERE source = 'env' AND pubkey = ?",
      );
      for (const row of envRows) {
        if (!keep.has(row.pubkey.toLowerCase())) {
          remove.run(row.pubkey);
        }
      }
    })();
  }

  /** Read all clients from the sdk_storage JSON blob. */
  getClients(): Client[] {
    const row = this.db
      .query("SELECT value FROM sdk_storage WHERE key = 'client_ids'")
      .get() as { value: string } | null;
    if (!row?.value) return [];
    try {
      return JSON.parse(row.value) as Client[];
    } catch {
      return [];
    }
  }

  /** Look up a client by their API key. */
  findByApiKey(apiKey: string): Client | null {
    return this.getClients().find((c) => c.apiKey === apiKey) ?? null;
  }

  /** Check if any clients exist (for bootstrap detection). */
  hasAnyClients(): boolean {
    return this.getClients().length > 0;
  }

  /**
   * Read the Routstr 21 model allowlist from the shared sdk_storage table.
   *
   * The daemon's SDK populates this on startup/refresh by fetching kind 38423
   * Nostr events. Returns an empty array if the key is missing or unparseable
   * — callers should fail-open in that case (daemon hasn't bootstrapped yet).
   */
  getRoutstr21Models(): string[] {
    const row = this.db
      .query("SELECT value FROM sdk_storage WHERE key = 'routstr21Models'")
      .get() as { value: string } | null;
    if (!row?.value) return [];
    try {
      const parsed = JSON.parse(row.value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  listNpubs(role?: NpubRole): NpubEntry[] {
    const where = role ? " WHERE role = ?" : "";
    const params = role ? [role] : [];
    const rows = this.db
      .query(`SELECT pubkey, npub, name, created_at, created_by, source, role FROM routstr_auth_npubs${where} ORDER BY created_at ASC, npub ASC`)
      .all(...params) as Array<{
        pubkey: string;
        npub: string;
        name: string | null;
        created_at: number;
        created_by: string | null;
        source: string;
        role: NpubRole;
      }>;

    return rows.map((row) => ({
      pubkey: row.pubkey,
      npub: row.npub,
      name: row.name,
      createdAt: row.created_at,
      createdBy: row.created_by,
      source: row.source,
      role: row.role,
    }));
  }

  /** @deprecated Use `countNpubs()` or `countNpubs('admin')`. */
  countAdminNpubs(): number {
    return this.countNpubs("admin");
  }

  countNpubs(role?: NpubRole): number {
    const where = role ? " WHERE role = ?" : "";
    const params = role ? [role] : [];
    const row = this.db
      .query(`SELECT COUNT(*) AS count FROM routstr_auth_npubs${where}`)
      .get(...params) as { count: number };
    return row.count;
  }

  /** @deprecated Use `hasNpub(pubkey)` or `hasNpubRole(pubkey, 'admin')`. */
  hasAdminPubkey(pubkey: string): boolean {
    return this.hasNpubRole(pubkey, "admin");
  }

  hasNpub(pubkey: string): boolean {
    const row = this.db
      .query("SELECT 1 FROM routstr_auth_npubs WHERE pubkey = ? LIMIT 1")
      .get(pubkey.toLowerCase()) as { 1: number } | null;
    return Boolean(row);
  }

  hasNpubRole(pubkey: string, role: NpubRole): boolean {
    const row = this.db
      .query("SELECT 1 FROM routstr_auth_npubs WHERE pubkey = ? AND role = ? LIMIT 1")
      .get(pubkey.toLowerCase(), role) as { 1: number } | null;
    return Boolean(row);
  }

  getNpubByPubkey(pubkey: string): NpubEntry | undefined {
    const row = this.db
      .query("SELECT pubkey, npub, name, created_at, created_by, source, role FROM routstr_auth_npubs WHERE pubkey = ?")
      .get(pubkey.toLowerCase()) as {
        pubkey: string;
        npub: string;
        name: string | null;
        created_at: number;
        created_by: string | null;
        source: string;
        role: NpubRole;
      } | null;

    if (!row) return undefined;
    return {
      pubkey: row.pubkey,
      npub: row.npub,
      name: row.name,
      createdAt: row.created_at,
      createdBy: row.created_by,
      source: row.source,
      role: row.role,
    };
  }

  addNpub(pubkey: string, role: NpubRole = "admin", createdBy: string | null = null, name: string | null = null): NpubEntry & { added: boolean } {
    const normalizedPubkey = pubkey.toLowerCase();
    const npub = nip19.npubEncode(normalizedPubkey);
    const now = Math.floor(Date.now() / 1000);

    const result = this.db
      .prepare(`
        INSERT OR IGNORE INTO routstr_auth_npubs
          (pubkey, npub, name, created_at, created_by, source, role)
        VALUES
          (?, ?, ?, ?, ?, 'api', ?)
      `)
      .run(normalizedPubkey, npub, name, now, createdBy?.toLowerCase() ?? null, role);

    const row = this.db
      .query("SELECT pubkey, npub, name, created_at, created_by, source, role FROM routstr_auth_npubs WHERE pubkey = ?")
      .get(normalizedPubkey) as {
        pubkey: string;
        npub: string;
        name: string | null;
        created_at: number;
        created_by: string | null;
        source: string;
        role: NpubRole;
      };

    return {
      pubkey: row.pubkey,
      npub: row.npub,
      name: row.name,
      createdAt: row.created_at,
      createdBy: row.created_by,
      source: row.source,
      role: row.role,
      added: result.changes > 0,
    };
  }

  /** @deprecated Use `addNpub(pubkey, 'admin', createdBy)`. */
  addAdminPubkey(pubkey: string, createdBy: string | null = null): NpubEntry & { added: boolean } {
    return this.addNpub(pubkey, "admin", createdBy);
  }

  /**
   * Update role and/or name for an npub in a single transaction so a failure
   * in one field can never leave a partial update behind.
   */
  updateNpub(
    pubkey: string,
    updates: { role?: NpubRole; name?: string | null },
  ): NpubEntry | null {
    const normalizedPubkey = pubkey.toLowerCase();
    const existing = this.getNpubByPubkey(normalizedPubkey);
    if (!existing) return null;

    const role = updates.role;
    const name = updates.name;

    this.db.transaction(() => {
      if (role !== undefined) {
        this.db
          .prepare("UPDATE routstr_auth_npubs SET role = ? WHERE pubkey = ?")
          .run(role, normalizedPubkey);
      }

      if (name !== undefined) {
        this.db
          .prepare("UPDATE routstr_auth_npubs SET name = ? WHERE pubkey = ?")
          .run(name, normalizedPubkey);
      }
    })();

    return this.getNpubByPubkey(normalizedPubkey)!;
  }

  updateNpubRole(pubkey: string, role: NpubRole): NpubEntry | null {
    return this.updateNpub(pubkey, { role });
  }

  updateNpubName(pubkey: string, name: string | null): NpubEntry | null {
    return this.updateNpub(pubkey, { name });
  }

  removeNpub(pubkey: string): boolean {
    const result = this.db
      .prepare("DELETE FROM routstr_auth_npubs WHERE pubkey = ?")
      .run(pubkey.toLowerCase());
    return result.changes > 0;
  }

  /** @deprecated Use `removeNpub(pubkey)`. */
  removeAdminPubkey(pubkey: string): boolean {
    return this.removeNpub(pubkey);
  }

  close(): void {
    this.db.close();
  }
}
