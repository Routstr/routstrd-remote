import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { AuthProxy, type AuthProxyConfig } from "./proxy";
import { AuthStore } from "./store";

/**
 * Tests for model allowlist enforcement (AUTH-001).
 *
 * Strategy: create a real AuthProxy with a temp SQLite DB, insert model data
 * directly into sdk_storage, and mock `fetch` so we can assert whether the
 * request was forwarded to upstream or blocked by the allowlist.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTmpDb(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "routstrd-auth-test-"));
  const dbPath = join(dir, "test.db");
  const db = new Database(dbPath);
  // Create the sdk_storage table that AuthStore expects.
  db.run("CREATE TABLE IF NOT EXISTS sdk_storage (key TEXT PRIMARY KEY, value TEXT)");
  // Create the npubs table that AuthStore.migrateNpubTable creates.
  db.run(`
    CREATE TABLE IF NOT EXISTS routstr_auth_npubs (
      pubkey TEXT PRIMARY KEY,
      npub TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      created_by TEXT,
      source TEXT NOT NULL DEFAULT 'api',
      role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'user'))
    )
  `);
  db.close();
  return { dbPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function setModels(dbPath: string, models: string[]) {
  const db = new Database(dbPath);
  db.run(
    "INSERT OR REPLACE INTO sdk_storage (key, value) VALUES ('routstr21Models', ?)",
    JSON.stringify(models),
  );
  db.close();
}

function setClients(dbPath: string, clients: { clientId: string; name: string; apiKey: string; createdAt: number; lastUsed: number | null }[]) {
  const db = new Database(dbPath);
  db.run(
    "INSERT OR REPLACE INTO sdk_storage (key, value) VALUES ('client_ids', ?)",
    JSON.stringify(clients),
  );
  db.close();
}

function makeConfig(dbPath: string, overrides: Partial<AuthProxyConfig> = {}): AuthProxyConfig {
  return {
    port: 0, // not used — we call handle() directly
    host: "127.0.0.1",
    upstream: "http://localhost:9999",
    dbPath,
    configFile: "",
    adminPubkeys: [],
    invalidAdminPubkeys: [],
    modelAllowlistEnabled: true,
    ...overrides,
  };
}

const TEST_MODELS = [
  "routstr/gpt-4o",
  "routstr/claude-3.5-sonnet",
  "routstr/llama-3.1-70b",
];

const TEST_API_KEY = "sk-test-key-12345";
const TEST_CLIENT = {
  clientId: "test-client",
  name: "Test Client",
  apiKey: TEST_API_KEY,
  createdAt: Date.now(),
  lastUsed: null,
};

// ─── NIP-98 helpers ──────────────────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}

function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function nip98Authorization(
  secretKey: Uint8Array,
  req: Request,
  body?: Uint8Array,
): Promise<string> {
  const tags: string[][] = [
    ["u", new URL(req.url).toString()],
    ["method", req.method],
  ];
  if (body && body.byteLength > 0) {
    tags.push(["payload", await sha256Hex(body)]);
  }

  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: "",
    },
    secretKey,
  );

  return `Nostr ${base64UrlEncode(JSON.stringify(event))}`;
}

// ─── Mock upstream ────────────────────────────────────────────────────────────

/** A mock fetch that records calls and returns a generic 200 response. */
function mockFetchUpstream() {
  const calls: { url: string; method: string; body?: string }[] = [];
  const originalFetch = globalThis.fetch;

  const mocked = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body;
    let bodyStr: string | undefined;
    if (body instanceof Uint8Array) {
      bodyStr = new TextDecoder().decode(body);
    } else if (typeof body === "string") {
      bodyStr = body;
    } else if (body instanceof ReadableStream) {
      bodyStr = "[stream]";
    }
    calls.push({ url, method: init?.method ?? "GET", body: bodyStr });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  globalThis.fetch = mocked as unknown as typeof fetch;
  return {
    calls,
    restore: () => { globalThis.fetch = originalFetch; },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("npub name endpoints", () => {
  let tmp: { dbPath: string; cleanup: () => void };
  let proxy: AuthProxy;

  beforeEach(() => {
    tmp = createTmpDb();
    proxy = new AuthProxy(makeConfig(tmp.dbPath));
  });

  afterEach(() => {
    proxy.close();
    tmp.cleanup();
  });

  it("POST /npubs trims and stores a name on bootstrap", async () => {
    const pubkey = "ef".repeat(32);
    const req = new Request("http://localhost:8008/npubs", {
      method: "POST",
      body: JSON.stringify({ pubkey, name: "  Alice  " }),
    });

    const res = await proxy.handle(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("Alice");
    expect(body.role).toBe("admin");
  });

  it("POST /npubs rejects a non-string name with 400", async () => {
    const req = new Request("http://localhost:8008/npubs", {
      method: "POST",
      body: JSON.stringify({ pubkey: "ef".repeat(32), name: 42 }),
    });

    const res = await proxy.handle(req);
    expect(res.status).toBe(400);
  });

  it("POST /npubs rejects a name over 64 characters with 400", async () => {
    const req = new Request("http://localhost:8008/npubs", {
      method: "POST",
      body: JSON.stringify({ pubkey: "ef".repeat(32), name: "x".repeat(65) }),
    });

    const res = await proxy.handle(req);
    expect(res.status).toBe(400);
  });

  it("GET /npubs requires NIP-98 auth", async () => {
    const req = new Request("http://localhost:8008/npubs");
    const res = await proxy.handle(req);
    expect(res.status).toBe(401);
  });

  it("GET /npubs returns names for an authenticated npub", async () => {
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const store = new AuthStore(tmp.dbPath);
    store.addNpub(pubkey, "admin", null, "Alice");
    store.close();

    proxy.close();
    proxy = new AuthProxy(makeConfig(tmp.dbPath));

    const req = new Request("http://localhost:8008/npubs");
    const auth = await nip98Authorization(secretKey, req);
    const res = await proxy.handle(
      new Request(req.url, { headers: { Authorization: auth } }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.npubs).toHaveLength(1);
    expect(body.npubs[0].name).toBe("Alice");
  });

  it("PATCH /npubs updates name only", async () => {
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const store = new AuthStore(tmp.dbPath);
    store.addNpub(pubkey, "admin", null, "Alice");
    store.close();

    proxy.close();
    proxy = new AuthProxy(makeConfig(tmp.dbPath));

    const payload = new TextEncoder().encode(
      JSON.stringify({ pubkey, name: "Bob" }),
    );
    const req = new Request("http://localhost:8008/npubs", {
      method: "PATCH",
      body: payload,
    });
    const auth = await nip98Authorization(secretKey, req, payload);
    const res = await proxy.handle(
      new Request(req.url, { method: "PATCH", headers: { Authorization: auth }, body: payload }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Bob");
    expect(body.role).toBe("admin");
  });

  it("PATCH /npubs clears a name with null", async () => {
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const store = new AuthStore(tmp.dbPath);
    store.addNpub(pubkey, "admin", null, "Alice");
    store.close();

    proxy.close();
    proxy = new AuthProxy(makeConfig(tmp.dbPath));

    const payload = new TextEncoder().encode(
      JSON.stringify({ pubkey, name: null }),
    );
    const req = new Request("http://localhost:8008/npubs", {
      method: "PATCH",
      body: payload,
    });
    const auth = await nip98Authorization(secretKey, req, payload);
    const res = await proxy.handle(
      new Request(req.url, { method: "PATCH", headers: { Authorization: auth }, body: payload }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBeNull();
  });

  it("POST /npubs returns 409 for a duplicate npub", async () => {
    const secretKey = generateSecretKey();
    const adminPubkey = getPublicKey(secretKey);
    const targetPubkey = "ef".repeat(32);
    const store = new AuthStore(tmp.dbPath);
    store.addNpub(adminPubkey, "admin", null, "Admin");
    store.addNpub(targetPubkey, "user", adminPubkey);
    store.close();

    proxy.close();
    proxy = new AuthProxy(makeConfig(tmp.dbPath));

    const payload = new TextEncoder().encode(
      JSON.stringify({ pubkey: targetPubkey, name: "Duplicate" }),
    );
    const req = new Request("http://localhost:8008/npubs", {
      method: "POST",
      body: payload,
    });
    const auth = await nip98Authorization(secretKey, req, payload);
    const res = await proxy.handle(
      new Request(req.url, { method: "POST", headers: { Authorization: auth }, body: payload }),
    );

    expect(res.status).toBe(409);
  });

  it("POST /npubs accepts a 64-character name", async () => {
    const req = new Request("http://localhost:8008/npubs", {
      method: "POST",
      body: JSON.stringify({ pubkey: "ef".repeat(32), name: "x".repeat(64) }),
    });

    const res = await proxy.handle(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("x".repeat(64));
  });

  it("GET /npubs is accessible to a registered user", async () => {
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const store = new AuthStore(tmp.dbPath);
    store.addNpub(pubkey, "user", null, "Carol");
    store.close();

    proxy.close();
    proxy = new AuthProxy(makeConfig(tmp.dbPath));

    const req = new Request("http://localhost:8008/npubs");
    const auth = await nip98Authorization(secretKey, req);
    const res = await proxy.handle(
      new Request(req.url, { headers: { Authorization: auth } }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.npubs).toHaveLength(1);
    expect(body.npubs[0].name).toBe("Carol");
    expect(body.npubs[0].role).toBe("user");
  });

  it("PATCH /npubs is rejected for a registered user (403)", async () => {
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const store = new AuthStore(tmp.dbPath);
    store.addNpub(pubkey, "user", null, "Carol");
    store.close();

    proxy.close();
    proxy = new AuthProxy(makeConfig(tmp.dbPath));

    const payload = new TextEncoder().encode(
      JSON.stringify({ pubkey, name: "Hacker" }),
    );
    const req = new Request("http://localhost:8008/npubs", {
      method: "PATCH",
      body: payload,
    });
    const auth = await nip98Authorization(secretKey, req, payload);
    const res = await proxy.handle(
      new Request(req.url, { method: "PATCH", headers: { Authorization: auth }, body: payload }),
    );

    expect(res.status).toBe(403);
  });

  it("PATCH /npubs updates role and name in one request", async () => {
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const store = new AuthStore(tmp.dbPath);
    store.addNpub(pubkey, "admin", null, "Alice");
    store.close();

    proxy.close();
    proxy = new AuthProxy(makeConfig(tmp.dbPath));

    const payload = new TextEncoder().encode(
      JSON.stringify({ pubkey, role: "user", name: "Bob" }),
    );
    const req = new Request("http://localhost:8008/npubs", {
      method: "PATCH",
      body: payload,
    });
    const auth = await nip98Authorization(secretKey, req, payload);
    const res = await proxy.handle(
      new Request(req.url, { method: "PATCH", headers: { Authorization: auth }, body: payload }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe("user");
    expect(body.name).toBe("Bob");
  });

  it("PATCH /npubs clears a name with a whitespace-only value", async () => {
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const store = new AuthStore(tmp.dbPath);
    store.addNpub(pubkey, "admin", null, "Alice");
    store.close();

    proxy.close();
    proxy = new AuthProxy(makeConfig(tmp.dbPath));

    const payload = new TextEncoder().encode(
      JSON.stringify({ pubkey, name: "   " }),
    );
    const req = new Request("http://localhost:8008/npubs", {
      method: "PATCH",
      body: payload,
    });
    const auth = await nip98Authorization(secretKey, req, payload);
    const res = await proxy.handle(
      new Request(req.url, { method: "PATCH", headers: { Authorization: auth }, body: payload }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBeNull();
  });
});

describe("Model Allowlist Enforcement (AUTH-001)", () => {
  let tmp: { dbPath: string; cleanup: () => void };
  let upstream: ReturnType<typeof mockFetchUpstream>;
  let proxy: AuthProxy;

  beforeEach(() => {
    tmp = createTmpDb();
    setModels(tmp.dbPath, TEST_MODELS);
    setClients(tmp.dbPath, [TEST_CLIENT]);
    upstream = mockFetchUpstream();
  });

  afterEach(() => {
    proxy?.close();
    upstream.restore();
    tmp.cleanup();
  });

  // --- Bearer path tests ---

  describe("Bearer auth path", () => {
    it("allows a request with a whitelisted model", async () => {
      proxy = new AuthProxy(makeConfig(tmp.dbPath));

      const req = new Request("http://localhost:8008/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${TEST_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "routstr/gpt-4o", messages: [] }),
      });

      const res = await proxy.handle(req);
      expect(res.status).toBe(200);
      expect(upstream.calls).toHaveLength(1);
    });

    it("blocks a request with a non-whitelisted model (403)", async () => {
      proxy = new AuthProxy(makeConfig(tmp.dbPath));

      const req = new Request("http://localhost:8008/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${TEST_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "openai/gpt-5-turbo", messages: [] }),
      });

      const res = await proxy.handle(req);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain("not in the Routstr 21 allowlist");
      expect(body.error).toContain("openai/gpt-5-turbo");
      // Should not have forwarded to upstream
      expect(upstream.calls).toHaveLength(0);
    });

    it("includes available models in the 403 error", async () => {
      proxy = new AuthProxy(makeConfig(tmp.dbPath));

      const req = new Request("http://localhost:8008/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${TEST_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "forbidden/model", messages: [] }),
      });

      const res = await proxy.handle(req);
      const body = await res.json();
      expect(body.error).toContain("routstr/gpt-4o");
      expect(body.error).toContain("routstr/claude-3.5-sonnet");
      expect(body.error).toContain("routstr/llama-3.1-70b");
    });

    it("allows requests with no model field in body", async () => {
      proxy = new AuthProxy(makeConfig(tmp.dbPath));

      const req = new Request("http://localhost:8008/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${TEST_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ messages: [] }),
      });

      const res = await proxy.handle(req);
      expect(res.status).toBe(200);
      expect(upstream.calls).toHaveLength(1);
    });

    it("forwards GET requests without model check", async () => {
      proxy = new AuthProxy(makeConfig(tmp.dbPath));

      // GET /models is a public path — should forward immediately
      const req = new Request("http://localhost:8008/models", {
        method: "GET",
        headers: { "Authorization": `Bearer ${TEST_API_KEY}` },
      });

      const res = await proxy.handle(req);
      expect(res.status).toBe(200);
      expect(upstream.calls).toHaveLength(1);
    });
  });

  // --- Fail-open behavior ---

  describe("fail-open on empty allowlist", () => {
    it("allows all models when DB allowlist is empty", async () => {
      // Create a DB with no routstr21Models key
      const emptyTmp = createTmpDb();
      setClients(emptyTmp.dbPath, [TEST_CLIENT]);

      const localUpstream = mockFetchUpstream();
      try {
        proxy = new AuthProxy(makeConfig(emptyTmp.dbPath));

        const req = new Request("http://localhost:8008/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${TEST_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model: "any/random-model", messages: [] }),
        });

        const res = await proxy.handle(req);
        expect(res.status).toBe(200);
        expect(localUpstream.calls).toHaveLength(1);
      } finally {
        proxy.close();
        localUpstream.restore();
        emptyTmp.cleanup();
      }
    });
  });

  // --- Config overrides ---

  describe("config: modelAllowlistEnabled", () => {
    it("allows all models when enforcement is disabled", async () => {
      proxy = new AuthProxy(makeConfig(tmp.dbPath, { modelAllowlistEnabled: false }));

      const req = new Request("http://localhost:8008/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${TEST_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "forbidden/model", messages: [] }),
      });

      const res = await proxy.handle(req);
      expect(res.status).toBe(200);
      expect(upstream.calls).toHaveLength(1);
    });
  });

  // --- Non-JSON bodies ---

  describe("non-JSON bodies", () => {
    it("skips model check for non-JSON body", async () => {
      proxy = new AuthProxy(makeConfig(tmp.dbPath));

      const req = new Request("http://localhost:8008/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${TEST_API_KEY}`,
          "Content-Type": "text/plain",
        },
        body: "plain text body",
      });

      const res = await proxy.handle(req);
      expect(res.status).toBe(200);
      expect(upstream.calls).toHaveLength(1);
    });
  });

  // --- Edge-case JSON bodies ---

  describe("edge-case JSON bodies", () => {
    it("skips model check for a JSON null body (does not throw)", async () => {
      proxy = new AuthProxy(makeConfig(tmp.dbPath));

      const req = new Request("http://localhost:8008/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${TEST_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: "null",
      });

      const res = await proxy.handle(req);
      expect(res.status).toBe(200);
      expect(upstream.calls).toHaveLength(1);
    });
  });

  // --- Store method ---

  describe("AuthStore.getRoutstr21Models()", () => {
    it("returns models from sdk_storage", () => {
      const { AuthStore } = require("./store");
      const store = new AuthStore(tmp.dbPath);
      const models = store.getRoutstr21Models();
      expect(models).toEqual(TEST_MODELS);
      store.close();
    });

    it("returns empty array when key is missing", () => {
      const emptyTmp = createTmpDb();
      const { AuthStore } = require("./store");
      const store = new AuthStore(emptyTmp.dbPath);
      const models = store.getRoutstr21Models();
      expect(models).toEqual([]);
      store.close();
      emptyTmp.cleanup();
    });

    it("returns empty array for invalid JSON", () => {
      const badTmp = createTmpDb();
      const db = new Database(badTmp.dbPath);
      db.run(
        "INSERT OR REPLACE INTO sdk_storage (key, value) VALUES ('routstr21Models', 'not-json')",
      );
      db.close();

      const { AuthStore } = require("./store");
      const store = new AuthStore(badTmp.dbPath);
      const models = store.getRoutstr21Models();
      expect(models).toEqual([]);
      store.close();
      badTmp.cleanup();
    });

    it("returns empty array for non-array JSON", () => {
      const badTmp = createTmpDb();
      const db = new Database(badTmp.dbPath);
      db.run(
        "INSERT OR REPLACE INTO sdk_storage (key, value) VALUES ('routstr21Models', '\"just-a-string\"')",
      );
      db.close();

      const { AuthStore } = require("./store");
      const store = new AuthStore(badTmp.dbPath);
      const models = store.getRoutstr21Models();
      expect(models).toEqual([]);
      store.close();
      badTmp.cleanup();
    });
  });
});
