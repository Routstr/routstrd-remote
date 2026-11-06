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
  // Monthly spend limits read the daemon's usage tracking table.
  db.run(`
    CREATE TABLE IF NOT EXISTS usage_tracking (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      client TEXT,
      sats_cost REAL NOT NULL
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

function setClients(dbPath: string, clients: { clientId: string; name: string; apiKey: string; createdAt: number; lastUsed: number | null; ownerNpub?: string }[]) {
  const db = new Database(dbPath);
  db.run(
    "INSERT OR REPLACE INTO sdk_storage (key, value) VALUES ('client_ids', ?)",
    JSON.stringify(clients),
  );
  db.close();
}

function setUsage(
  dbPath: string,
  rows: Array<{ client: string; sats: number; timestamp?: number }>,
) {
  const db = new Database(dbPath);
  const insert = db.prepare(
    "INSERT INTO usage_tracking (id, timestamp, client, sats_cost) VALUES (?, ?, ?, ?)",
  );
  rows.forEach((row, index) =>
    insert.run(
      `usage-${Date.now()}-${Math.random().toString(36).slice(2)}-${index}`,
      row.timestamp ?? Date.now(),
      row.client,
      row.sats,
    ),
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
  const calls: { url: string; method: string; body?: string; headers: Headers }[] = [];
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
    calls.push({ url, method: init?.method ?? "GET", body: bodyStr, headers: new Headers(init?.headers) });
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

  it("GET /npubs allows NIP-98 bootstrap when no npubs are configured", async () => {
    const secretKey = generateSecretKey();
    const req = new Request("http://localhost:8008/npubs");
    const auth = await nip98Authorization(secretKey, req);
    const res = await proxy.handle(
      new Request(req.url, { headers: { Authorization: auth } }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.npubs).toEqual([]);
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

  describe("Anthropic x-api-key authentication", () => {
    function request(headers: Record<string, string>, model = TEST_MODELS[1]!) {
      return new Request("http://localhost:8008/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ model, messages: [], max_tokens: 16 }),
      });
    }

    it("validates and forwards a mixed-case x-api-key with the original body", async () => {
      proxy = new AuthProxy(makeConfig(tmp.dbPath));
      const res = await proxy.handle(request({ "X-API-Key": TEST_API_KEY }));
      expect(res.status).toBe(200);
      expect(upstream.calls).toHaveLength(1);
      expect(upstream.calls[0]!.headers.get("x-api-key")).toBe(TEST_API_KEY);
      expect(upstream.calls[0]!.headers.get("authorization")).toBe(`Bearer ${TEST_API_KEY}`);
      expect(upstream.calls[0]!.url).toBe("http://localhost:9999/v1/messages");
      expect(JSON.parse(upstream.calls[0]!.body!).model).toBe(TEST_MODELS[1]);
    });

    it("forwards without buffering when the allowlist is disabled", async () => {
      proxy = new AuthProxy(makeConfig(tmp.dbPath, { modelAllowlistEnabled: false }));
      expect((await proxy.handle(request({ "x-api-key": TEST_API_KEY }))).status).toBe(200);
      expect(upstream.calls[0]!.body).toBe("[stream]");
    });

    it("rejects invalid, empty and missing keys", async () => {
      proxy = new AuthProxy(makeConfig(tmp.dbPath));
      for (const headers of [{ "x-api-key": "invalid" }, { "x-api-key": "" }, {}]) {
        expect((await proxy.handle(request(headers))).status).toBe(401);
      }
      expect(upstream.calls).toHaveLength(0);
    });

    it("enforces the same model allowlist", async () => {
      proxy = new AuthProxy(makeConfig(tmp.dbPath));
      expect((await proxy.handle(request({ "x-api-key": TEST_API_KEY }, "blocked-model"))).status).toBe(403);
      expect(upstream.calls).toHaveLength(0);
    });

    it("does not grant wallet, daemon-control or client-management access", async () => {
      proxy = new AuthProxy(makeConfig(tmp.dbPath));
      for (const path of ["/wallet/balance", "/wallet/send/cashu", "/stop", "/providers", "/clients/add"]) {
        const res = await proxy.handle(new Request(`http://localhost:8008${path}`, {
          method: "POST", headers: { "x-api-key": TEST_API_KEY }, body: "{}",
        }));
        expect([401, 403]).toContain(res.status);
      }
      expect(upstream.calls).toHaveLength(0);
    });

    it("never falls back from an explicit invalid Authorization header", async () => {
      proxy = new AuthProxy(makeConfig(tmp.dbPath));
      for (const authorization of ["Bearer invalid", "Basic invalid", "Nostr invalid", ""]) {
        expect((await proxy.handle(request({ Authorization: authorization, "x-api-key": TEST_API_KEY }))).status).toBe(401);
      }
      expect(upstream.calls).toHaveLength(0);
    });

    it("prefers valid Bearer auth over an invalid x-api-key", async () => {
      proxy = new AuthProxy(makeConfig(tmp.dbPath));
      expect((await proxy.handle(request({ Authorization: `Bearer ${TEST_API_KEY}`, "x-api-key": "invalid" }))).status).toBe(200);
      expect(upstream.calls[0]!.headers.get("authorization")).toBe(`Bearer ${TEST_API_KEY}`);
      expect(upstream.calls[0]!.headers.get("x-api-key")).toBe(TEST_API_KEY);
    });

    it("canonicalizes accepted Bearer spellings for downstream spend attribution", async () => {
      for (const modelAllowlistEnabled of [true, false]) {
        proxy = new AuthProxy(makeConfig(tmp.dbPath, { modelAllowlistEnabled }));
        for (const authorization of [
          `bearer ${TEST_API_KEY}`,
          `bEaReR ${TEST_API_KEY}`,
          `Bearer  ${TEST_API_KEY}`,
          `Bearer\t${TEST_API_KEY}`,
        ]) {
          const res = await proxy.handle(request({ Authorization: authorization }));
          expect(res.status).toBe(200);
          const forwarded = upstream.calls.at(-1)!;
          expect(forwarded.headers.get("authorization")).toBe(`Bearer ${TEST_API_KEY}`);
          expect(forwarded.headers.get("authorization")!.slice(7)).toBe(TEST_API_KEY);
          expect(forwarded.body).toBe(modelAllowlistEnabled
            ? JSON.stringify({ model: TEST_MODELS[1], messages: [], max_tokens: 16 })
            : "[stream]");
        }
        proxy.close();
      }
      expect(upstream.calls).toHaveLength(8);
    });

    it("allows Anthropic headers in browser preflights without forwarding", async () => {
      proxy = new AuthProxy(makeConfig(tmp.dbPath));
      const res = await proxy.handle(new Request("http://localhost:8008/v1/messages", {
        method: "OPTIONS",
        headers: { "Access-Control-Request-Headers": "x-api-key,anthropic-version,anthropic-beta" },
      }));
      expect(res.status).toBe(204);
      const allowed = res.headers.get("Access-Control-Allow-Headers")!.toLowerCase();
      for (const header of ["x-api-key", "anthropic-version", "anthropic-beta"]) expect(allowed).toContain(header);
      expect(upstream.calls).toHaveLength(0);
    });
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

describe("Monthly spend limits", () => {
  let tmp: { dbPath: string; cleanup: () => void };
  let upstream: ReturnType<typeof mockFetchUpstream>;
  let proxy: AuthProxy;

  beforeEach(() => {
    tmp = createTmpDb();
    upstream = mockFetchUpstream();
  });

  afterEach(() => {
    proxy?.close();
    upstream.restore();
    tmp.cleanup();
  });

  /**
   * Register an npub plus one API-key client owned by it. `spent` is written as
   * usage for the current month.
   */
  function setupNpub(options: {
    role?: "admin" | "user";
    limit?: number | null;
    spent?: number;
    clientId?: string;
  } = {}) {
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const store = new AuthStore(tmp.dbPath);
    const entry = store.addNpub(
      pubkey,
      options.role ?? "user",
      null,
      "Alice",
      options.limit === undefined ? null : options.limit,
    );
    const apiKey = `sk-quota-${pubkey.slice(0, 8)}`;
    const clientId = options.clientId ?? `pi-agent-${entry.npub.slice(-7)}`;
    setClients(tmp.dbPath, [
      {
        clientId,
        name: "Pi Agent",
        apiKey,
        createdAt: 1,
        lastUsed: null,
        ownerNpub: entry.npub,
      },
    ]);
    if (options.spent) {
      setUsage(tmp.dbPath, [{ client: clientId, sats: options.spent }]);
    }
    store.close();
    return { secretKey, pubkey, npub: entry.npub, apiKey, clientId };
  }

  function paidBearerRequest(apiKey: string, path = "/v1/chat/completions") {
    return new Request(`http://localhost:8008${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "routstr/gpt-4o", messages: [] }),
    });
  }

  async function paidNip98Request(secretKey: Uint8Array, path = "/v1/chat/completions") {
    const body = new TextEncoder().encode(
      JSON.stringify({ model: "routstr/gpt-4o", messages: [] }),
    );
    const req = new Request(`http://localhost:8008${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const authorization = await nip98Authorization(secretKey, req, body);
    return new Request(req.url, {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      body,
    });
  }

  it("returns 503 for capped inference on missing or broken accounting and recovers", async () => {
    const { apiKey } = setupNpub({ limit: 1_000 });
    proxy = new AuthProxy(makeConfig(tmp.dbPath));
    const db = new Database(tmp.dbPath);
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const schema of [null, "CREATE TABLE usage_tracking (timestamp INTEGER, client TEXT)"]) {
        db.run("DROP TABLE IF EXISTS usage_tracking");
        if (schema) db.run(schema);
        const res = await proxy.handle(paidBearerRequest(apiKey));
        expect(res.status).toBe(503);
        expect((await res.json()).code).toBe("quota_accounting_unavailable");
        expect(upstream.calls).toHaveLength(0);
      }
      db.run("DROP TABLE usage_tracking");
      db.run("CREATE TABLE usage_tracking (timestamp INTEGER, client TEXT, sats_cost REAL)");
      expect((await proxy.handle(paidBearerRequest(apiKey))).status).toBe(200);
      expect(upstream.calls).toHaveLength(1);
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
      db.close();
    }
  });

  it("keeps unlimited inference and capped management available without accounting", async () => {
    const { apiKey, secretKey } = setupNpub({ role: "admin", limit: null });
    proxy = new AuthProxy(makeConfig(tmp.dbPath));
    const db = new Database(tmp.dbPath);
    db.run("DROP TABLE usage_tracking");
    db.close();
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await proxy.handle(paidBearerRequest(apiKey))).status).toBe(200);
      const store = new AuthStore(tmp.dbPath);
      store.updateNpubMonthlyLimit(getPublicKey(secretKey), 1_000);
      store.close();
      expect((await proxy.handle(await paidNip98Request(secretKey, "/wallet/unlock"))).status).toBe(200);

      const req = new Request("http://localhost:8008/npubs");
      const authorization = await nip98Authorization(secretKey, req);
      const res = await proxy.handle(new Request(req.url, { headers: { Authorization: authorization } }));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.npubs[0].monthlyLimitSats).toBe(1_000);
      expect(data.npubs[0].monthlyUsedSats).toBeUndefined();

      const body = new TextEncoder().encode(JSON.stringify({ pubkey: getPublicKey(secretKey), monthlyLimitSats: null }));
      const patch = new Request(req.url, { method: "PATCH", body });
      const auth = await nip98Authorization(secretKey, patch, body);
      const updated = await proxy.handle(new Request(req.url, {
        method: "PATCH", headers: { Authorization: auth }, body,
      }));
      expect(updated.status).toBe(200);
      expect((await updated.json()).monthlyLimitSats).toBeNull();
    } finally { log.mockRestore(); }
  });

  it("allows a paid Bearer request below the cap", async () => {
    const { apiKey } = setupNpub({ limit: 1_000, spent: 500 });
    proxy = new AuthProxy(makeConfig(tmp.dbPath));

    const res = await proxy.handle(paidBearerRequest(apiKey));
    expect(res.status).toBe(200);
    expect(upstream.calls).toHaveLength(1);
  });

  it("blocks a paid Bearer request once the cap is reached", async () => {
    const { apiKey, npub } = setupNpub({ limit: 1_000, spent: 1_000 });
    proxy = new AuthProxy(makeConfig(tmp.dbPath));

    const res = await proxy.handle(paidBearerRequest(apiKey));
    expect(res.status).toBe(402);
    expect(upstream.calls).toHaveLength(0);

    const body = await res.json();
    expect(body.code).toBe("monthly_quota_exceeded");
    expect(body.monthlyLimitSats).toBe(1_000);
    expect(body.monthlyUsedSats).toBe(1_000);
    expect(body.error).toContain(npub);
    expect(res.headers.get("X-Routstr-Quota-Limit-Sats")).toBe("1000");
    expect(res.headers.get("X-Routstr-Quota-Used-Sats")).toBe("1000");
    expect(Number(res.headers.get("X-Routstr-Quota-Reset"))).toBeGreaterThan(Date.now() / 1000);
    expect(res.headers.get("Retry-After")).toMatch(/^\d+$/);
  });

  it("blocks when spend exceeds the cap by a fraction of a sat", async () => {
    const { apiKey } = setupNpub({ limit: 100, spent: 100.5 });
    proxy = new AuthProxy(makeConfig(tmp.dbPath));

    expect((await proxy.handle(paidBearerRequest(apiKey))).status).toBe(402);
    expect(upstream.calls).toHaveLength(0);
  });

  it("does not count last month's spend", async () => {
    const { apiKey, clientId } = setupNpub({ limit: 100 });
    const lastMonth = Date.now() - 40 * 24 * 60 * 60 * 1000;
    setUsage(tmp.dbPath, [{ client: clientId, sats: 10_000, timestamp: lastMonth }]);
    proxy = new AuthProxy(makeConfig(tmp.dbPath));

    expect((await proxy.handle(paidBearerRequest(apiKey))).status).toBe(200);
  });

  it("treats a null limit as unlimited", async () => {
    const { apiKey } = setupNpub({ limit: null, spent: 1_000_000 });
    proxy = new AuthProxy(makeConfig(tmp.dbPath));

    expect((await proxy.handle(paidBearerRequest(apiKey))).status).toBe(200);
  });

  it("treats a limit of 0 as blocking immediately", async () => {
    const { apiKey } = setupNpub({ limit: 0 });
    proxy = new AuthProxy(makeConfig(tmp.dbPath));

    expect((await proxy.handle(paidBearerRequest(apiKey))).status).toBe(402);
  });

  it("sums spend across every client owned by the npub", async () => {
    const { apiKey, npub } = setupNpub({ limit: 100, spent: 60 });
    setClients(tmp.dbPath, [
      {
        clientId: `pi-agent-${npub.slice(-7)}`,
        name: "Pi Agent",
        apiKey,
        createdAt: 1,
        lastUsed: null,
        ownerNpub: npub,
      },
      {
        clientId: `claude-code-${npub.slice(-7)}`,
        name: "Claude Code",
        apiKey: "sk-second-client",
        createdAt: 1,
        lastUsed: null,
        ownerNpub: npub,
      },
    ]);
    setUsage(tmp.dbPath, [
      { client: `claude-code-${npub.slice(-7)}`, sats: 50 },
    ]);
    proxy = new AuthProxy(makeConfig(tmp.dbPath));

    expect((await proxy.handle(paidBearerRequest(apiKey))).status).toBe(402);
  });

  it("does not block another npub's paid requests", async () => {
    setupNpub({ limit: 10, spent: 1_000 });
    const other = setupNpub({ limit: 1_000, spent: 10 });
    proxy = new AuthProxy(makeConfig(tmp.dbPath));

    expect((await proxy.handle(paidBearerRequest(other.apiKey))).status).toBe(200);
  });

  it("does not block non-paid management routes", async () => {
    const { secretKey } = setupNpub({ role: "admin", limit: 0, spent: 1_000 });
    proxy = new AuthProxy(makeConfig(tmp.dbPath));

    const res = await proxy.handle(await paidNip98Request(secretKey, "/wallet/unlock"));
    expect(res.status).toBe(200);
    expect(upstream.calls).toHaveLength(1);
  });

  it("blocks a paid NIP-98 request once the cap is reached", async () => {
    const { secretKey } = setupNpub({ limit: 500, spent: 900 });
    proxy = new AuthProxy(makeConfig(tmp.dbPath));

    const res = await proxy.handle(await paidNip98Request(secretKey));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("capped_npub_requires_api_key");
    expect(upstream.calls).toHaveLength(0);
  });

  it("rejects paid NIP-98 for capped npubs even below the cap or with zero spend", async () => {
    for (const limit of [0, 500]) {
      const { secretKey } = setupNpub({ limit });
      proxy = new AuthProxy(makeConfig(tmp.dbPath));
      const res = await proxy.handle(await paidNip98Request(secretKey));
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("capped_npub_requires_api_key");
      proxy.close();
    }
    expect(upstream.calls).toHaveLength(0);
  });

  it("allows paid NIP-98 for unlimited npubs", async () => {
    const { secretKey } = setupNpub({ limit: null });
    proxy = new AuthProxy(makeConfig(tmp.dbPath));
    expect((await proxy.handle(await paidNip98Request(secretKey))).status).toBe(200);
    expect(upstream.calls).toHaveLength(1);
  });

  it("POST /npubs accepts a monthly limit on creation", async () => {
    const pubkey = "ef".repeat(32);
    const res = await proxyWithoutDb().handle(
      new Request("http://localhost:8008/npubs", {
        method: "POST",
        body: JSON.stringify({ pubkey, monthlyLimitSats: 2_500 }),
      }),
    );
    expect(res.status).toBe(201);
    expect((await res.json()).monthlyLimitSats).toBe(2_500);
  });

  it("PATCH /npubs sets, updates and clears the monthly limit", async () => {
    const { secretKey, pubkey } = setupNpub({ role: "admin" });
    proxy = new AuthProxy(makeConfig(tmp.dbPath));

    const patch = async (monthlyLimitSats: number | null) => {
      const payload = new TextEncoder().encode(
        JSON.stringify({ pubkey, monthlyLimitSats }),
      );
      const req = new Request("http://localhost:8008/npubs", {
        method: "PATCH",
        body: payload,
      });
      const auth = await nip98Authorization(secretKey, req, payload);
      return proxy.handle(
        new Request(req.url, {
          method: "PATCH",
          headers: { Authorization: auth },
          body: payload,
        }),
      );
    };

    const set = await patch(7_500);
    expect(set.status).toBe(200);
    expect((await set.json()).monthlyLimitSats).toBe(7_500);

    const cleared = await patch(null);
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).monthlyLimitSats).toBeNull();
  });

  it("PATCH /npubs rejects invalid monthly limits", async () => {
    const { secretKey, pubkey } = setupNpub({ role: "admin" });
    proxy = new AuthProxy(makeConfig(tmp.dbPath));

    for (const monthlyLimitSats of [-1, 1.5, "1000"]) {
      const payload = new TextEncoder().encode(
        JSON.stringify({ pubkey, monthlyLimitSats }),
      );
      const req = new Request("http://localhost:8008/npubs", {
        method: "PATCH",
        body: payload,
      });
      const auth = await nip98Authorization(secretKey, req, payload);
      const res = await proxy.handle(
        new Request(req.url, {
          method: "PATCH",
          headers: { Authorization: auth },
          body: payload,
        }),
      );
      expect(res.status).toBe(400);
    }
  });

  it("GET /npubs returns each npub's limit and current-month spend", async () => {
    const secretKey = generateSecretKey();
    const adminPubkey = getPublicKey(secretKey);
    const store = new AuthStore(tmp.dbPath);
    store.addNpub(adminPubkey, "admin");
    const target = store.addNpub("ef".repeat(32), "user", adminPubkey, "Bob", 4_000);
    const clientId = `pi-agent-${target.npub.slice(-7)}`;
    setClients(tmp.dbPath, [
      {
        clientId,
        name: "Pi Agent",
        apiKey: "sk-target",
        createdAt: 1,
        lastUsed: null,
        ownerNpub: target.npub,
      },
    ]);
    setUsage(tmp.dbPath, [{ client: clientId, sats: 1_234.9 }]);
    store.close();
    proxy = new AuthProxy(makeConfig(tmp.dbPath));

    const req = new Request("http://localhost:8008/npubs");
    const auth = await nip98Authorization(secretKey, req);
    const res = await proxy.handle(
      new Request(req.url, { headers: { Authorization: auth } }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    const bob = body.npubs.find((n: { npub: string }) => n.npub === target.npub);
    expect(bob.monthlyLimitSats).toBe(4_000);
    expect(bob.monthlyUsedSats).toBe(1_234);
    expect(body.monthlyResetAt).toBeGreaterThan(Date.now() / 1000);
  });

  it("hides other members' spend from a non-admin", async () => {
    const adminKey = generateSecretKey();
    const adminPubkey = getPublicKey(adminKey);
    const memberKey = generateSecretKey();
    const memberPubkey = getPublicKey(memberKey);
    const store = new AuthStore(tmp.dbPath);
    const admin = store.addNpub(adminPubkey, "admin");
    const member = store.addNpub(memberPubkey, "user");
    setClients(tmp.dbPath, [
      {
        clientId: `pi-agent-${admin.npub.slice(-7)}`,
        name: "Admin Pi",
        apiKey: "sk-admin",
        createdAt: 1,
        lastUsed: null,
        ownerNpub: admin.npub,
      },
      {
        clientId: `pi-agent-${member.npub.slice(-7)}`,
        name: "Member Pi",
        apiKey: "sk-member",
        createdAt: 1,
        lastUsed: null,
        ownerNpub: member.npub,
      },
    ]);
    setUsage(tmp.dbPath, [
      { client: `pi-agent-${admin.npub.slice(-7)}`, sats: 111 },
      { client: `pi-agent-${member.npub.slice(-7)}`, sats: 222 },
    ]);
    store.close();
    proxy = new AuthProxy(makeConfig(tmp.dbPath));

    const listAs = async (secretKey: Uint8Array) => {
      const req = new Request("http://localhost:8008/npubs");
      const auth = await nip98Authorization(secretKey, req);
      const res = await proxy.handle(
        new Request(req.url, { headers: { Authorization: auth } }),
      );
      expect(res.status).toBe(200);
      return (await res.json()) as {
        npubs: Array<{ npub: string; monthlyUsedSats?: number }>;
      };
    };

    const asMember = await listAs(memberKey);
    const own = asMember.npubs.find((n) => n.npub === member.npub)!;
    const other = asMember.npubs.find((n) => n.npub === admin.npub)!;
    expect(own.monthlyUsedSats).toBe(222);
    expect(other.monthlyUsedSats).toBeUndefined();

    const asAdmin = await listAs(adminKey);
    expect(
      asAdmin.npubs.find((n) => n.npub === member.npub)!.monthlyUsedSats,
    ).toBe(222);
  });

  function proxyWithoutDb() {
    return new AuthProxy(makeConfig(tmp.dbPath));
  }
});
