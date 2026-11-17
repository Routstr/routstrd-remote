import { Database } from "bun:sqlite";
import { nip19 } from "nostr-tools";
import { monthStart } from "./quota";

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
  /**
   * Monthly spend cap in sats, or null for no limit. Spend resets on the first
   * of each calendar month (server local time).
   */
  monthlyLimitSats: number | null;
}

interface NpubRow {
  pubkey: string;
  npub: string;
  name: string | null;
  created_at: number;
  created_by: string | null;
  source: string;
  role: NpubRole;
  monthly_limit_sats: number | null;
}

const NPUB_COLUMNS =
  "pubkey, npub, name, created_at, created_by, source, role, monthly_limit_sats";

/**
 * Pubkeys that must be deleted, not demoted, when they disappear from
 * `ROUTSTRD_AUTH_ADMIN_NPUBS`.
 *
 * `reconcileEnvAdminPubkeys` cannot tell a security revocation from a routine
 * configuration change by looking at the env var alone, so a revocation has to
 * be declared here. Leaving a compromised pubkey in the table as an ordinary
 * admin is not an acceptable outcome, so this list is the safety valve.
 *
 * The first entry is the npub `docker-entrypoint.sh` used to default
 * `ROUTSTRD_AUTH_ADMIN_NPUBS` to, which silently granted admin on every
 * deployment that never overrode the variable. It is purged on sight, exactly
 * as before — see dc95d27.
 *
 * Adding to this list is a permanent, one-way action for deployments that still
 * have the row: the npub is deleted on the next start, and re-adding it to
 * `ROUTSTRD_AUTH_ADMIN_NPUBS` will only re-create it if the operator does so
 * after this file changes.
 */
export const RETIRED_ENV_ADMIN_PUBKEYS: ReadonlySet<string> = new Set([
  // Hardcoded default admin npub from docker-entrypoint.sh before dc95d27.
  "fc76f8bdeeafc37a5a499b3a24064774d8a5a02c299a64aca072cf8c6c827b1f",
]);

function rowToNpubEntry(row: NpubRow): NpubEntry {
  return {
    pubkey: row.pubkey,
    npub: row.npub,
    name: row.name,
    createdAt: row.created_at,
    createdBy: row.created_by,
    source: row.source,
    role: row.role,
    monthlyLimitSats: row.monthly_limit_sats ?? null,
  };
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
          role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'user')),
          monthly_limit_sats INTEGER
        )
      `);

      // Migrate: add name column if it doesn't exist (older DBs won't have it).
      const cols = this.db
        .query("PRAGMA table_info(routstr_auth_npubs)")
        .all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "name")) {
        this.db.run("ALTER TABLE routstr_auth_npubs ADD COLUMN name TEXT");
      }

      // Migrate: add the monthly spend cap. NULL means unlimited, which is
      // also the right default for every npub registered before this existed.
      if (!cols.some((c) => c.name === "monthly_limit_sats")) {
        this.db.run(
          "ALTER TABLE routstr_auth_npubs ADD COLUMN monthly_limit_sats INTEGER",
        );
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
   * Make the npub table agree with `ROUTSTRD_AUTH_ADMIN_NPUBS`.
   *
   * - A pubkey in the variable is an env-managed admin: inserted if missing,
   *   otherwise re-stamped to `source='env', role='admin'`.
   * - A pubkey that left the variable loses admin (otherwise removing it would
   *   leave it admin forever, see dc95d27) but stays registered as a `user`, so
   *   its API keys keep working and the table cannot empty out underneath the
   *   first-admin bootstrap guard.
   * - A pubkey on `RETIRED_ENV_ADMIN_PUBKEYS` is deleted outright.
   *
   * Rows that were never env-managed (`source='api'`) are not touched.
   */
  private reconcileEnvAdminPubkeys(pubkeys: string[]): void {
    const uniquePubkeys = [...new Set(pubkeys.map((p) => p.toLowerCase()))];
    const keep = new Set(uniquePubkeys);
    const now = Math.floor(Date.now() / 1000);

    this.db.transaction(() => {
      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO routstr_auth_npubs
          (pubkey, npub, created_at, created_by, source, role, monthly_limit_sats)
        VALUES
          (?, ?, ?, NULL, 'env', 'admin', NULL)
      `);
      for (const pubkey of uniquePubkeys) {
        insert.run(pubkey, nip19.npubEncode(pubkey), now);
      }

      // Rows still listed in the env var are env-managed admins, whatever the
      // row currently says. INSERT OR IGNORE above leaves an existing row alone,
      // so without this a pubkey that was registered through `POST /npubs`
      // (possibly as a `user`) and is then listed in the variable would keep
      // its old source and role: the variable would not grant admin, and the
      // row would not be recognised as env-managed when it later leaves the
      // variable. The env var is the ground truth for both.
      const markEnv = this.db.prepare(
        "UPDATE routstr_auth_npubs SET source = 'env', role = 'admin' " +
          "WHERE pubkey = ? AND (source != 'env' OR role != 'admin')",
      );
      for (const pubkey of uniquePubkeys) {
        markEnv.run(pubkey);
      }

      const envRows = this.db
        .query("SELECT pubkey, npub FROM routstr_auth_npubs WHERE source = 'env'")
        .all() as Array<{ pubkey: string; npub: string }>;

      const isRetired = (pubkey: string) => RETIRED_ENV_ADMIN_PUBKEYS.has(pubkey);

      // Two very different meanings hide behind "no longer in the env var", and
      // they must not be handled the same way:
      //
      //   1. The operator retired a known-compromised pubkey. That is a
      //      security revocation, so the row is deleted. This is the original
      //      reason reconcile deletes at all -- it is how the hardcoded default
      //      admin was purged in dc95d27 -- and it has to keep working.
      //
      //   2. Anything else: the operator no longer wants this pubkey to be an
      //      env-configured admin. The row loses admin -- that is what
      //      dc95d27 guarantees, and keeping it would mean removing someone
      //      from the variable grants them admin forever -- but it is *not*
      //      deleted. It stays registered as a `user` with its name, limit and
      //      created_at intact.
      //
      // Deleting in case 2 would take the npub's own API keys with it, because
      // a key whose recorded owner is no longer registered is refused with
      // `client_owner_not_registered`, and when it was the last npub it would
      // empty the table and re-open the anonymous first-admin bootstrap window.
      // An env var edit must not be able to do either. Full revocation is
      // `DELETE /npubs/<npub>`; keeping the npub as an admin is
      // `PATCH /npubs` with `role: admin` (the row is `source='api'` by then,
      // so that sticks).
      const remove = this.db.prepare("DELETE FROM routstr_auth_npubs WHERE pubkey = ?");
      const demote = this.db.prepare(
        "UPDATE routstr_auth_npubs SET source = 'api', role = 'user' WHERE pubkey = ?",
      );
      const demoted: string[] = [];

      for (const row of envRows) {
        if (keep.has(row.pubkey.toLowerCase())) continue;
        if (isRetired(row.pubkey)) {
          remove.run(row.pubkey);
        } else {
          demote.run(row.pubkey);
          demoted.push(row.npub);
        }
      }

      if (demoted.length > 0) {
        console.warn(
          `  Warning: ${demoted.length} npub(s) left ROUTSTRD_AUTH_ADMIN_NPUBS and are no longer admin: ` +
            `${demoted.join(", ")}. They stay registered as 'user', so their existing API keys keep working.`,
        );
        console.warn(
          "  To revoke one completely, use 'DELETE /npubs/<npub>'. To keep one as an admin, " +
            "'PATCH /npubs' it with role 'admin'.",
        );
        const adminsLeft = this.db
          .query("SELECT COUNT(*) AS count FROM routstr_auth_npubs WHERE role = 'admin'")
          .get() as { count: number };
        if (adminsLeft.count === 0) {
          console.warn(
            "  Warning: no admin npub is registered any more. The first-admin bootstrap stays closed " +
              "because npubs are still registered, so set ROUTSTRD_AUTH_ADMIN_NPUBS again and restart " +
              "to regain admin access.",
          );
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
      .query(`SELECT ${NPUB_COLUMNS} FROM routstr_auth_npubs${where} ORDER BY created_at ASC, npub ASC`)
      .all(...params) as NpubRow[];

    return rows.map(rowToNpubEntry);
  }

  /** @deprecated Use `countNpubs()` or `countNpubs('admin')`. */
  countAdminNpubs(): number {
    return this.countNpubs("admin");
  }

  /**
   * Npubs with no display name. Only rows bootstrapped from the environment or
   * migrated from the legacy admin table can be unnamed: the API requires a
   * name on creation and refuses to clear one.
   */
  listUnnamedNpubs(): NpubEntry[] {
    return this.listNpubs().filter((entry) => entry.name === null);
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
      .query(`SELECT ${NPUB_COLUMNS} FROM routstr_auth_npubs WHERE pubkey = ?`)
      .get(pubkey.toLowerCase()) as NpubRow | null;

    return row ? rowToNpubEntry(row) : undefined;
  }

  addNpub(
    pubkey: string,
    role: NpubRole = "admin",
    createdBy: string | null = null,
    name: string | null = null,
    monthlyLimitSats: number | null = null,
  ): NpubEntry & { added: boolean } {
    const normalizedPubkey = pubkey.toLowerCase();
    const npub = nip19.npubEncode(normalizedPubkey);
    const now = Math.floor(Date.now() / 1000);

    const result = this.db
      .prepare(`
        INSERT OR IGNORE INTO routstr_auth_npubs
          (pubkey, npub, name, created_at, created_by, source, role, monthly_limit_sats)
        VALUES
          (?, ?, ?, ?, ?, 'api', ?, ?)
      `)
      .run(
        normalizedPubkey,
        npub,
        name,
        now,
        createdBy?.toLowerCase() ?? null,
        role,
        monthlyLimitSats,
      );

    const row = this.db
      .query(`SELECT ${NPUB_COLUMNS} FROM routstr_auth_npubs WHERE pubkey = ?`)
      .get(normalizedPubkey) as NpubRow;

    return {
      ...rowToNpubEntry(row),
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
    updates: {
      role?: NpubRole;
      name?: string | null;
      monthlyLimitSats?: number | null;
    },
  ): NpubEntry | null {
    const normalizedPubkey = pubkey.toLowerCase();
    const existing = this.getNpubByPubkey(normalizedPubkey);
    if (!existing) return null;

    const role = updates.role;
    const name = updates.name;
    const monthlyLimitSats = updates.monthlyLimitSats;

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

      if (monthlyLimitSats !== undefined) {
        this.db
          .prepare(
            "UPDATE routstr_auth_npubs SET monthly_limit_sats = ? WHERE pubkey = ?",
          )
          .run(monthlyLimitSats, normalizedPubkey);
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

  updateNpubMonthlyLimit(
    pubkey: string,
    monthlyLimitSats: number | null,
  ): NpubEntry | null {
    return this.updateNpub(pubkey, { monthlyLimitSats });
  }

  /**
   * Sats spent per client id since the start of the current calendar month.
   *
   * Reads the daemon's `usage_tracking` table (timestamps are Unix ms).
   * Throws when accounting is unavailable, including a missing usage table;
   * callers must not interpret an accounting failure as zero spend.
   */
  getMonthlyUsageByClient(now: number = Date.now()): Map<string, number> {
    const rows = this.db
      .query(
        `SELECT client, SUM(sats_cost) AS sats
           FROM usage_tracking
          WHERE timestamp >= ? AND client IS NOT NULL
          GROUP BY client`,
      )
      .all(monthStart(now)) as Array<{ client: string; sats: number }>;

    const usage = new Map<string, number>();
    for (const row of rows) {
      if (!row.client) continue;
      const sats = Number(row.sats);
      if (!Number.isFinite(sats)) throw new Error("Invalid monthly usage total");
      usage.set(row.client, sats);
    }
    return usage;
  }

  /**
   * Current-month sats spent per npub.
   *
   * Usage rows only carry a client id. The owning npub comes from the client's
   * `ownerNpub`, falling back to the 7-character npub suffix the auth proxy
   * appends to every client id. The fallback keeps spend attributed after a
   * client is deleted and re-created under a new id.
   */
  getMonthlyUsageByNpub(now: number = Date.now()): Map<string, number> {
    const usage = this.getMonthlyUsageByClient(now);
    if (usage.size === 0) return new Map();

    const suffixToNpub = new Map<string, string>();
    for (const entry of this.listNpubs()) {
      suffixToNpub.set(entry.npub.slice(-7), entry.npub);
    }

    const ownerByClient = new Map<string, string | null>();
    for (const client of this.getClients()) {
      ownerByClient.set(client.clientId, client.ownerNpub ?? null);
    }

    const byNpub = new Map<string, number>();
    for (const [clientId, sats] of usage) {
      const owner =
        ownerByClient.get(clientId) ?? suffixToNpub.get(clientId.slice(-7));
      if (!owner) continue;
      byNpub.set(owner, (byNpub.get(owner) ?? 0) + sats);
    }
    return byNpub;
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
