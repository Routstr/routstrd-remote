import { join } from "path";
import { existsSync } from "fs";
import { nip19 } from "nostr-tools";

const HOME = process.env.HOME || process.env.USERPROFILE || "";
const IS_CLOUDRON = process.env.CLOUDRON === "1";
const DEFAULT_ROUTSTRD_DIR = IS_CLOUDRON ? "/app/data/routstrd" : join(HOME, ".routstrd");

/** Directory for routstr config (shared with routstrd). */
export const ROUTSTRD_DIR = process.env.ROUTSTRD_DIR || DEFAULT_ROUTSTRD_DIR;

/** Path to the shared SQLite database. */
export const DB_PATH =
  process.env.ROUTSTRD_DB_PATH || join(ROUTSTRD_DIR, "routstr.db");

/** Path to the config file (JSON, routstrd-compatible). */
export const CONFIG_FILE =
  process.env.ROUTSTRD_CONFIG_FILE || join(ROUTSTRD_DIR, "config.json");

/** Default public port (clients connect here). */
export const DEFAULT_PORT = Number(process.env.ROUTSTRD_AUTH_PORT) || 8008;

/** Default upstream (routstrd daemon) — must be local-only. */
export const DEFAULT_UPSTREAM =
  process.env.ROUTSTRD_UPSTREAM ||
  (IS_CLOUDRON ? "http://localhost:8009" : "http://localhost:8008");

/** Default host for the auth proxy. */
export const DEFAULT_HOST = process.env.ROUTSTRD_AUTH_HOST || "0.0.0.0";

const ADMIN_PUBKEYS_RAW = [
  process.env.ROUTSTRD_AUTH_ADMIN_PUBKEYS,
  process.env.ROUTSTRD_AUTH_ADMIN_NPUBS,
  process.env.ROUTSTRD_AUTH_BOOTSTRAP_NPUB,
]
  .filter(Boolean)
  .join(",");

export function normalizeNostrPubkey(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^[a-f0-9]{64}$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  if (trimmed.toLowerCase().startsWith("npub1")) {
    try {
      const decoded = nip19.decode(trimmed);
      if (decoded.type === "npub" && typeof decoded.data === "string") {
        return decoded.data.toLowerCase();
      }
    } catch {
      return null;
    }
  }

  return null;
}

function parseAdminPubkeys(raw: string): {
  pubkeys: string[];
  invalid: string[];
} {
  const values = raw
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);

  const pubkeys = new Set<string>();
  const invalid: string[] = [];

  for (const value of values) {
    const pubkey = normalizeNostrPubkey(value);
    if (pubkey) {
      pubkeys.add(pubkey);
    } else {
      invalid.push(value);
    }
  }

  return { pubkeys: [...pubkeys], invalid };
}

/**
 * Whether model allowlist enforcement is enabled.
 *
 * Disabled by default. Set ROUTSTRD_AUTH_MODEL_ALLOWLIST=true to enable.
 */
export function isModelAllowlistEnabled(
  envValue: string | undefined = process.env.ROUTSTRD_AUTH_MODEL_ALLOWLIST,
): boolean {
  return envValue === "true";
}

export const MODEL_ALLOWLIST_ENABLED = isModelAllowlistEnabled();

export interface AuthProxyConfig {
  /** Public port to listen on. */
  port: number;
  /** Host to bind. */
  host: string;
  /** Upstream routstrd daemon URL. */
  upstream: string;
  /** Path to the shared SQLite DB. */
  dbPath: string;
  /** Optional: path to a JSON config file for bootstrapping. */
  configFile: string;
  /** Nostr pubkeys that are allowed to perform admin-only actions. */
  adminPubkeys: string[];
  /** Invalid admin pubkey env-var values, reported during validation. */
  invalidAdminPubkeys: string[];
  /** Whether model allowlist enforcement is enabled. */
  modelAllowlistEnabled: boolean;
}

/**
 * Load configuration with env-var overrides.
 */
export function loadConfig(): AuthProxyConfig {
  const adminPubkeys = parseAdminPubkeys(ADMIN_PUBKEYS_RAW);

  const config: AuthProxyConfig = {
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    upstream: DEFAULT_UPSTREAM,
    dbPath: DB_PATH,
    configFile: CONFIG_FILE,
    adminPubkeys: adminPubkeys.pubkeys,
    invalidAdminPubkeys: adminPubkeys.invalid,
    modelAllowlistEnabled: MODEL_ALLOWLIST_ENABLED,
  };

  return config;
}

/**
 * Validate that the DB file exists, returning a human-friendly error if not.
 */
export function validateConfig(cfg: AuthProxyConfig): string | null {
  if (cfg.invalidAdminPubkeys.length > 0) {
    return `Invalid admin Nostr pubkey(s): ${cfg.invalidAdminPubkeys.join(", ")}. Use npub or 64-char hex pubkeys.`;
  }

  if (!existsSync(cfg.dbPath)) {
    return `Database not found at ${cfg.dbPath}. Make sure routstrd has been initialized (routstrd onboard).`;
  }
  return null;
}