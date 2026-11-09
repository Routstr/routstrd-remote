import { normalizeNostrPubkey, type AuthProxyConfig } from "./config";
import { validateNIP98Request } from "./nip98";
import { requestAuthorization } from "./auth";
import { nextMonthStart, secondsUntilNextMonth } from "./quota";
import { type Client, type NpubRole, AuthStore } from "./store";

interface ParseNpubOptions {
  /** Reject a body that does not carry a usable display name (npub creation). */
  requireName?: boolean;
  /** Reject an explicit attempt to clear the name (npub updates). */
  forbidNameClear?: boolean;
}

/**
 * Display names are mandatory when an npub is registered, so the admin list
 * always says who an identity belongs to. The message names the CLI flag and
 * the upgrade path, because an older `routstrd` cannot send `--name` at all.
 */
const NPUB_NAME_REQUIRED_ERROR =
  "Missing required field 'name'. Provide a display name (1-64 characters), " +
  "e.g. routstrd npubs add <npub> --name \"Alice\". If your routstrd does not " +
  "support --name, update it first ('npm i -g routstrd@latest').";

const NPUB_NAME_CLEAR_ERROR =
  "Invalid name. A display name cannot be removed; provide a new name (1-64 characters).";

/** Parsed body of the npub management endpoints (`POST`/`PATCH /npubs`). */
interface NpubBody {
  pubkey: string;
  role?: NpubRole;
  name?: string | null;
  monthlyLimitSats?: number | null;
}
/**
 * Thin proxy that validates Bearer tokens or NIP-98 Nostr HTTP auth events and
 * forwards requests to the routstrd daemon running on localhost only.
 */
export class AuthProxy {
  private config: AuthProxyConfig;
  private store: AuthStore;

  constructor(config: AuthProxyConfig) {
    this.config = config;
    this.store = new AuthStore(config.dbPath, config.adminPubkeys);
  }

  /**
   * Forward a request to the upstream routstrd daemon.
   * @param stripAuth - If true (default), removes the Authorization header before forwarding.
   *                    Pass false to keep the auth header (used for Bearer/sauth tokens).
   */
  private async forward(
    req: Request,
    body?: Uint8Array,
    stripAuth = true,
    validatedApiKey?: string,
  ): Promise<Response> {
    const url = new URL(req.url);
    const upstreamUrl = `${this.config.upstream}${url.pathname}${url.search}`;

    const headers = new Headers(req.headers);
    if (stripAuth) {
      headers.delete("authorization");
    }
    if (validatedApiKey !== undefined) {
      // Use the exact credential we authenticated, in the SDK's canonical form.
      // Never let casing/whitespace or a conflicting x-api-key change attribution.
      headers.set("authorization", `Bearer ${validatedApiKey}`);
      if (headers.has("x-api-key")) headers.set("x-api-key", validatedApiKey);
    }
    headers.delete("host");
    headers.delete("content-length");

    const requestBody =
      req.method === "GET" || req.method === "HEAD"
        ? undefined
        : body ?? req.body;

    try {
      const response = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body: requestBody,
      });

      // Tell nginx/reverse proxies not to buffer streamed responses. This is
      // especially important for SSE/LLM streaming where buffering or idle
      // proxy timeouts can make streams appear to end mid-response.
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set("X-Accel-Buffering", "no");

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } catch {
      return new Response("Upstream unreachable", { status: 502 });
    }
  }

  private json(
    data: unknown,
    status = 200,
    headers: Record<string, string> = {},
  ): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
  }

  private parseNpubBody(
    raw: unknown,
    options: ParseNpubOptions = {},
  ): NpubBody | Response {
    if (raw === undefined || raw === null || (ArrayBuffer.isView(raw) && (raw as ArrayBufferView).byteLength === 0)) {
      return this.json({ error: "Request body is required. Provide { \"npub\": \"npub1...\" } or { \"pubkey\": \"<64-char hex>\" }." }, 400);
    }

    // Accept raw Uint8Array
    if (ArrayBuffer.isView(raw) || raw instanceof ArrayBuffer) {
      const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      if (bytes.byteLength === 0) {
        return this.json({ error: "Request body is required. Provide { \"npub\": \"npub1...\" } or { \"pubkey\": \"<64-char hex>\" }." }, 400);
      }
      const buf = bytes as Uint8Array;
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(buf));
      } catch {
        return this.json({ error: "Invalid JSON body." }, 400);
      }
      return this.extractNpub(parsed, options);
    }

    // Accept already-parsed JSON object
    return this.extractNpub(raw, options);
  }

  private extractNpub(
    parsed: unknown,
    options: ParseNpubOptions = {},
  ): NpubBody | Response {
    const value = typeof parsed === "string"
      ? parsed
      : parsed && typeof parsed === "object"
        ? (parsed as { npub?: unknown; pubkey?: unknown }).npub ??
          (parsed as { npub?: unknown; pubkey?: unknown }).pubkey
        : null;

    if (typeof value !== "string") {
      return this.json({ error: "Body must include an npub or pubkey string." }, 400);
    }

    const pubkey = normalizeNostrPubkey(value);
    if (!pubkey) {
      return this.json({ error: "Invalid npub/pubkey. Use npub or 64-char hex pubkey." }, 400);
    }

    const result: NpubBody = { pubkey };

    if (parsed && typeof parsed === "object") {
      const roleRaw = (parsed as { role?: unknown }).role;
      if (roleRaw !== undefined) {
        if (roleRaw === "admin" || roleRaw === "user") {
          result.role = roleRaw;
        } else {
          return this.json({ error: "Invalid role. Expected 'admin' or 'user'." }, 400);
        }
      }

      const nameRaw = (parsed as { name?: unknown }).name;
      if (nameRaw !== undefined) {
        if (nameRaw === null) {
          result.name = null;
        } else if (typeof nameRaw === "string") {
          const trimmed = nameRaw.trim();
          if ([...trimmed].length > 64) {
            return this.json({ error: "Invalid name. Maximum length is 64 characters." }, 400);
          }
          result.name = trimmed === "" ? null : trimmed;
        } else {
          return this.json({ error: "Invalid name. Expected a string or null." }, 400);
        }
      }

      const limitRaw = (parsed as { monthlyLimitSats?: unknown }).monthlyLimitSats;
      if (limitRaw !== undefined) {
        if (limitRaw === null) {
          result.monthlyLimitSats = null;
        } else if (
          typeof limitRaw === "number" &&
          Number.isSafeInteger(limitRaw) &&
          limitRaw >= 0
        ) {
          result.monthlyLimitSats = limitRaw;
        } else {
          return this.json({
            error:
              "Invalid monthlyLimitSats. Expected a non-negative integer number of sats, or null to remove the limit.",
          }, 400);
        }
      }
    }

    // Creating an npub requires a name so every entry in the admin list is
    // attributable to a person. Clearing one is refused for the same reason.
    if (options.requireName && (result.name === undefined || result.name === null)) {
      return this.json({ error: NPUB_NAME_REQUIRED_ERROR, field: "name" }, 400);
    }
    if (options.forbidNameClear && result.name === null) {
      return this.json({ error: NPUB_NAME_CLEAR_ERROR, field: "name" }, 400);
    }

    return result;
  }

  private async authenticateNpub(
    req: Request,
    authorization: string | null,
    body: Uint8Array | undefined,
    requiredRole: NpubRole,
  ): Promise<{ pubkey: string; npub: string; role: NpubRole } | Response> {
    if (!authorization) {
      return this.json({
        error:
          "Missing Authorization header. This endpoint requires NIP-98 auth from a registered npub/pubkey.",
      }, 401);
    }

    if (authorization.match(/^Bearer\s+(.+)$/i)) {
      return this.json({
        error: requiredRole === "admin"
          ? "Admin-only action. This endpoint requires NIP-98 auth from a registered npub/pubkey."
          : "This endpoint requires NIP-98 auth from a registered npub/pubkey.",
      }, 403);
    }

    if (!authorization.match(/^Nostr\s+(.+)$/i)) {
      return this.json({
        error: "Invalid Authorization format. Expected 'Nostr <base64-event>'.",
      }, 401);
    }

    try {
      const { pubkey } = await validateNIP98Request(authorization, req, body);

      const entry = this.store.getNpubByPubkey(pubkey);
      if (!entry) {
        return this.json({
          error: this.store.countNpubs() === 0
            ? "This endpoint requires a registered npub/pubkey, but none is configured. Register the first admin with 'routstrd npubs register'."
            : "This endpoint requires NIP-98 auth from a registered npub/pubkey.",
        }, 403);
      }

      if (requiredRole === "admin" && entry.role !== "admin") {
        return this.json({
          error: "Admin access required. Only admin npubs can perform this action.",
        }, 403);
      }

      return { pubkey, npub: entry.npub, role: entry.role };
    } catch (err) {
      return this.json({
        error: err instanceof Error ? err.message : "Invalid NIP-98 token.",
      }, 401);
    }
  }

  /**
   * Check if a request's model field is in the Routstr 21 allowlist.
   *
   * Returns `null` if the request is allowed (or if the check doesn't apply).
   * Returns a `Response` (403) if the model is not in the allowlist.
   *
   * Behavior:
   * - Skips if allowlist enforcement is disabled via config.
   * - Skips non-POST requests or requests without a body.
   * - Reads the allowlist from the shared DB.
   * - Fails open (allows all) if the allowlist is empty — the daemon may not
   *   have bootstrapped the model list yet.
   * - Skips if the body isn't valid JSON or has no `model` field.
   */
  private checkModelAllowlist(
    body: Uint8Array | undefined,
    method: string,
  ): Response | null {
    if (!this.config.modelAllowlistEnabled) return null;
    if (method !== "POST" || !body || body.byteLength === 0) return null;

    const allowlist = this.store.getRoutstr21Models();
    if (allowlist.length === 0) return null; // fail-open: daemon hasn't bootstrapped

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return null; // non-JSON body — skip check
    }

    let model = "";
    if (typeof parsed === "object" && parsed !== null) {
      const value = (parsed as { model?: unknown }).model;
      if (typeof value === "string") model = value;
    }
    if (!model) return null; // no model field — let upstream handle it

    if (!allowlist.includes(model)) {
      return this.json(
        {
          error: `Model '${model}' is not in the Routstr 21 allowlist. Available models: ${allowlist.join(", ")}`,
        },
        403,
      );
    }

    return null;
  }

  /**
   * The npub that owns a client. Prefers the explicit `ownerNpub` and falls
   * back to the npub suffix the proxy appends to every client id.
   */
  private resolveClientNpub(client: Client): string | undefined {
    const npubs = this.store.listNpubs();
    if (client.ownerNpub) {
      const owner = npubs.find((entry) => entry.npub === client.ownerNpub);
      if (owner) return owner.pubkey;
    }
    for (const entry of npubs) {
      if (client.clientId.endsWith(`-${this.getNpubSuffix(entry.npub)}`)) {
        return entry.pubkey;
      }
    }
    return undefined;
  }

  /**
   * Enforce an npub's monthly sats cap.
   *
   * Returns a 402 response when the cap has already been reached, or null when
   * the request may proceed. Spend is summed from the daemon's usage tracking
   * table for the current calendar month. The request that crosses the cap is
   * allowed -- its cost is only known after it completes -- and every following
   * paid request is blocked until the month rolls over or an admin raises the
   * limit.
   */
  /** Unavailable totals must never be displayed or enforced as zero spend. */
  private readMonthlyUsage(): Map<string, number> | null {
    try {
      return this.store.getMonthlyUsageByNpub();
    } catch (error) {
      console.error("Monthly quota accounting unavailable:", error);
      return null;
    }
  }

  private checkMonthlyQuota(npub: string): Response | null {
    const entry = this.store.getNpubByPubkey(npub);
    if (!entry || entry.monthlyLimitSats === null) return null;

    const limit = entry.monthlyLimitSats;
    const usage = this.readMonthlyUsage();
    if (usage === null) {
      return this.json({
        error: "Cannot verify monthly spend right now. Please retry later.",
        code: "quota_accounting_unavailable",
        error_type: "quota_accounting_unavailable",
      }, 503);
    }
    const used = usage.get(entry.npub) ?? 0;
    if (used < limit) return null;

    const resetAt = Math.floor(nextMonthStart() / 1000);
    const usedWhole = Math.floor(used);
    return this.json(
      {
        error:
          `Monthly spend limit reached: ${usedWhole} of ${limit} sats used for ${entry.npub}. ` +
          "The limit resets on the first of next month; ask an admin to raise it.",
        error_type: "monthly_quota_exceeded",
        code: "monthly_quota_exceeded",
        monthlyLimitSats: limit,
        monthlyUsedSats: usedWhole,
        monthlyResetAt: resetAt,
      },
      402,
      {
        "Retry-After": String(secondsUntilNextMonth()),
        "X-Routstr-Quota-Limit-Sats": String(limit),
        "X-Routstr-Quota-Used-Sats": String(usedWhole),
        "X-Routstr-Quota-Reset": String(resetAt),
      },
    );
  }

  /** Apply the monthly cap only to requests that can spend money. */
  private quotaResponse(npub: string, req: Request, nip98 = false): Response | null {
    if (!AuthProxy.isPaidRequest(req.method, new URL(req.url).pathname)) {
      return null;
    }
    if (nip98) {
      const entry = this.store.getNpubByPubkey(npub);
      if (entry && entry.monthlyLimitSats !== null) {
        return this.json({
          error: "Paid NIP-98 requests are not supported for capped npubs. Use an API-key client so spend can be accounted.",
          code: "capped_npub_requires_api_key",
          error_type: "capped_npub_requires_api_key",
        }, 403);
      }
    }
    return this.checkMonthlyQuota(npub);
  }

  private getNpubSuffix(npub: string): string {
    return npub.slice(-7);
  }

  private addSuffixToId(id: string, suffix: string): string {
    return id.endsWith(`-${suffix}`) ? id : `${id}-${suffix}`;
  }

  private removeSuffixFromId(id: string, suffix: string): string {
    const suffixStr = `-${suffix}`;
    return id.endsWith(suffixStr) ? id.slice(0, -suffixStr.length) : id;
  }

  private sanitizeClientId(value: string): string {
    return value
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "");
  }

  private clientBelongsToNpub(client: Client, npub: string, suffix: string): boolean {
    // Prefer the explicit owner when present. The suffix fallback keeps older
    // clients usable until they are re-created/migrated with ownerNpub.
    return client.ownerNpub ? client.ownerNpub === npub : client.clientId.endsWith(`-${suffix}`);
  }

  private stripClientOwnerSuffix(client: Client, suffix: string, ownerNpub: string) {
    return {
      id: this.removeSuffixFromId(client.clientId, suffix),
      name: client.name,
      apiKey: client.apiKey,
      createdAt: client.createdAt,
      lastUsed: client.lastUsed,
      ownerNpub: client.ownerNpub ?? ownerNpub,
    };
  }

  private async handleClients(req: Request, path: string): Promise<Response> {
    const body = req.method === "GET" || req.method === "HEAD"
      ? undefined
      : new Uint8Array(await req.arrayBuffer());
    const auth = await this.authenticateNpub(
      req,
      req.headers.get("authorization"),
      body,
      "user",
    );
    if (auth instanceof Response) return auth;

    const suffix = this.getNpubSuffix(auth.npub);

    if (req.method === "GET" && path === "/clients") {
      const clients = this.store.getClients()
        .filter((c) => this.clientBelongsToNpub(c, auth.npub, suffix))
        .map((c) => this.stripClientOwnerSuffix(c, suffix, auth.npub));

      return this.json({
        output: {
          clients,
          totalCount: clients.length,
        },
      });
    }

    if (req.method === "POST" && path === "/clients/add") {
      let parsed: Record<string, unknown>;
      try {
        parsed = body && body.byteLength > 0
          ? JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>
          : {};
      } catch {
        return this.json({ error: "Invalid JSON body." }, 400);
      }

      const name = parsed.name;
      const explicitId = parsed.id;
      if (!name || typeof name !== "string" || name.trim() === "") {
        return this.json({ error: "Missing required 'name' field (must be a non-empty string)." }, 400);
      }
      if (!explicitId || typeof explicitId !== "string" || explicitId.trim() === "") {
        return this.json({ error: "Missing required 'id' field (must be a non-empty string)." }, 400);
      }

      const unsuffixedId = this.removeSuffixFromId(this.sanitizeClientId(explicitId), suffix);
      if (!unsuffixedId) {
        return this.json({ error: "Invalid client id. Must contain alphanumeric characters." }, 400);
      }

      const upstreamBody = new TextEncoder().encode(JSON.stringify({
        ...parsed,
        id: this.addSuffixToId(unsuffixedId, suffix),
        ownerNpub: auth.npub,
      }));

      const upstreamReq = new Request(req.url, {
        method: req.method,
        headers: req.headers,
        body: upstreamBody,
      });
      const response = await this.forward(upstreamReq, upstreamBody);

      if (!response.ok) return response;
      const payload = await response.json() as {
        output?: { client?: { id?: string; ownerNpub?: string } };
        error?: string;
      };
      if (payload.output?.client?.id) {
        payload.output.client.id = this.removeSuffixFromId(payload.output.client.id, suffix);
      }
      if (payload.output?.client && !payload.output.client.ownerNpub) {
        payload.output.client.ownerNpub = auth.npub;
      }
      return this.json(payload, response.status);
    }

    if (req.method === "POST" && path === "/clients/delete") {
      let parsed: Record<string, unknown>;
      try {
        parsed = body && body.byteLength > 0
          ? JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>
          : {};
      } catch {
        return this.json({ error: "Invalid JSON body." }, 400);
      }

      const id = parsed.id;
      if (!id || typeof id !== "string" || id.trim() === "") {
        return this.json({ error: "Missing required 'id' field (must be a non-empty string)." }, 400);
      }

      const unsuffixedId = this.removeSuffixFromId(this.sanitizeClientId(id), suffix);
      if (!unsuffixedId) {
        return this.json({ error: "Invalid client id. Must contain alphanumeric characters." }, 400);
      }

      const resolvedId = this.addSuffixToId(unsuffixedId, suffix);
      const client = this.store.getClients().find((c) => c.clientId === resolvedId);
      if (!client || !this.clientBelongsToNpub(client, auth.npub, suffix)) {
        return this.json({ error: `Client with id '${unsuffixedId}' not found.` }, 404);
      }

      const upstreamBody = new TextEncoder().encode(JSON.stringify({
        ...parsed,
        id: resolvedId,
      }));
      const upstreamReq = new Request(req.url, {
        method: req.method,
        headers: req.headers,
        body: upstreamBody,
      });
      const response = await this.forward(upstreamReq, upstreamBody);

      if (!response.ok) return response;
      const payload = await response.json() as {
        output?: { message?: string; id?: string };
        error?: string;
      };
      if (payload.output?.id) {
        payload.output.id = this.removeSuffixFromId(payload.output.id, suffix);
      }
      return this.json(payload, response.status);
    }

    return this.json({ error: "Not found." }, 404);
  }

  private async handleUsage(req: Request): Promise<Response> {
    if (req.method !== "GET") {
      return this.json({ error: "Not found." }, 404);
    }

    const auth = await this.authenticateNpub(
      req,
      req.headers.get("authorization"),
      undefined,
      "user",
    );
    if (auth instanceof Response) return auth;

    // Forward to daemon with npub filter; daemon handles scoping and suffix stripping.
    const url = new URL(req.url);
    url.searchParams.set("npub", auth.npub);

    const modifiedReq = new Request(url.toString(), {
      method: req.method,
      headers: req.headers,
    });

    return this.forward(modifiedReq);
  }

  /** Handle /npubs management endpoints. */
  private async handleNpubs(req: Request, path: string): Promise<Response> {
    if (req.method === "GET" && path === "/npubs") {
      const authorization = req.headers.get("authorization");

      // Bootstrap read: `routstrd npubs register` first lists npubs to check
      // whether an admin already exists. Requiring a *registered* npub here
      // deadlocks bootstrap (nothing is registered yet), so when the store is
      // empty accept any valid NIP-98 event and return an empty list.
      if (this.store.countNpubs() === 0) {
        if (!authorization) {
          return this.json({
            error:
              "Missing Authorization header. This endpoint requires NIP-98 auth from a registered npub/pubkey.",
          }, 401);
        }
        if (!authorization.match(/^Nostr\s+(.+)$/i)) {
          return this.json({
            error: "Invalid Authorization format. Expected 'Nostr <base64-event>'.",
          }, 401);
        }
        try {
          await validateNIP98Request(authorization, req, undefined);
        } catch (err) {
          return this.json({
            error: err instanceof Error ? err.message : "Invalid NIP-98 token.",
          }, 401);
        }
        return this.json({ npubs: [] });
      }

      const auth = await this.authenticateNpub(
        req,
        authorization,
        undefined,
        "user",
      );
      if (auth instanceof Response) return auth;

      const npubs = this.store.listNpubs();
      const monthlyUsage = this.readMonthlyUsage();
      // Spend is private: admins see everyone's, a member only their own.
      const canSeeUsage = (entryPubkey: string) =>
        auth.role === "admin" || entryPubkey === auth.pubkey;
      return this.json({
        npubs: npubs.map((n) => ({
          npub: n.npub,
          name: n.name,
          role: n.role,
          monthlyLimitSats: n.monthlyLimitSats,
          ...(monthlyUsage !== null && canSeeUsage(n.pubkey)
            ? { monthlyUsedSats: Math.floor(monthlyUsage.get(n.npub) ?? 0) }
            : {}),
        })),
        monthlyResetAt: Math.floor(nextMonthStart() / 1000),
      });
    }

    if (req.method === "POST" && path === "/npubs") {
      const body = new Uint8Array(await req.arrayBuffer());
      const anyNpubs = this.store.countNpubs() > 0;
      let createdBy: string | null = null;

      if (anyNpubs) {
        const auth = await this.authenticateNpub(
          req,
          req.headers.get("authorization"),
          body,
          "admin",
        );
        if (auth instanceof Response) return auth;
        createdBy = auth.pubkey;
      }

      const parsed = this.parseNpubBody(body, { requireName: true });
      if (parsed instanceof Response) return parsed;

      // Bootstrap the very first registered npub as admin by default. After
      // bootstrap, default to user unless an admin explicitly sets role=admin.
      const role = parsed.role ?? (anyNpubs ? "user" : "admin");
      const name = parsed.name ?? null;
      const monthlyLimitSats = parsed.monthlyLimitSats ?? null;
      const entry = this.store.addNpub(
        parsed.pubkey,
        role,
        createdBy,
        name,
        monthlyLimitSats,
      );
      if (!entry.added) {
        return this.json({
          error: "npub/pubkey already registered. Use PATCH /npubs to update its role, name or limit.",
          npub: entry.npub,
          pubkey: entry.pubkey,
        }, 409);
      }

      return this.json({
        npub: entry.npub,
        pubkey: entry.pubkey,
        name: entry.name,
        role: entry.role,
        monthlyLimitSats: entry.monthlyLimitSats,
        added: entry.added,
      }, 201);
    }

    if (req.method === "DELETE" && (path === "/npubs" || path.startsWith("/npubs/"))) {
      const body = req.method === "GET" || req.method === "HEAD"
        ? undefined
        : new Uint8Array(await req.arrayBuffer());
      const auth = await this.authenticateNpub(
        req,
        req.headers.get("authorization"),
        body,
        "admin",
      );
      if (auth instanceof Response) return auth;

      const url = new URL(req.url);
      const rawValue = path.startsWith("/npubs/")
        ? decodeURIComponent(path.slice("/npubs/".length))
        : url.searchParams.get("npub") ?? url.searchParams.get("pubkey");

      let pubkey: string | Response | null = rawValue
        ? normalizeNostrPubkey(rawValue)
        : null;

      if (!pubkey && body && body.byteLength > 0) {
        const parsed = this.parseNpubBody(body);
        if (parsed instanceof Response) return parsed;
        pubkey = parsed.pubkey;
      }

      if (!pubkey) {
        return this.json({ error: "Provide the npub/pubkey to remove in /npubs/<npub>, ?npub=..., or the JSON body." }, 400);
      }

      const removed = this.store.removeNpub(pubkey);
      return this.json({ removed });
    }

    if (req.method === "PATCH" && path === "/npubs") {
      const body = new Uint8Array(await req.arrayBuffer());
      const auth = await this.authenticateNpub(
        req,
        req.headers.get("authorization"),
        body,
        "admin",
      );
      if (auth instanceof Response) return auth;

      const parsed = this.parseNpubBody(body, { forbidNameClear: true });
      if (parsed instanceof Response) return parsed;

      if (
        !parsed.role &&
        parsed.name === undefined &&
        parsed.monthlyLimitSats === undefined
      ) {
        return this.json({
          error:
            "Missing required field. Provide 'role', 'name', and/or 'monthlyLimitSats' to update.",
        }, 400);
      }

      const updated = this.store.updateNpub(parsed.pubkey, {
        role: parsed.role,
        name: parsed.name,
        monthlyLimitSats: parsed.monthlyLimitSats,
      });
      if (!updated) {
        return this.json({ error: "npub/pubkey not found." }, 404);
      }

      const monthlyUsage = this.readMonthlyUsage();
      return this.json({
        npub: updated.npub,
        pubkey: updated.pubkey,
        name: updated.name,
        role: updated.role,
        monthlyLimitSats: updated.monthlyLimitSats,
        ...(monthlyUsage !== null
          ? { monthlyUsedSats: Math.floor(monthlyUsage.get(updated.npub) ?? 0) }
          : {}),
        monthlyResetAt: Math.floor(nextMonthStart() / 1000),
      });
    }

    return this.json({ error: "Not found." }, 404);
  }

  /** Handle a single incoming request. */
  async handle(req: Request): Promise<Response> {
    const res = req.method === "OPTIONS"
      ? new Response(null, { status: 204 })
      : await this.route(req);
    for (const [name, value] of Object.entries(AuthProxy.CORS_HEADERS)) {
      res.headers.set(name, value);
    }
    return res;
  }

  private async route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const authorization = requestAuthorization(req);

    // Bun preserves leading `//` inbound but collapses it on outbound fetch,
    // which would make exact path authorization and the daemon disagree.
    if (path.startsWith("//")) {
      return this.json({ error: "Invalid request path." }, 400);
    }

    if (path === "/npubs" || path.startsWith("/npubs/")) {
      return this.handleNpubs(req, path);
    }

    if (path === "/clients" || path === "/clients/add" || path === "/clients/delete") {
      return this.handleClients(req, path);
    }

    if (path === "/usage" || path === "/usage/summary") {
      return this.handleUsage(req);
    }

    // `/usage` and `/usage/summary` are served above with the caller's npub
    // injected so the daemon scopes rows to that identity. Every other
    // `/usage*` path -- notably the daemon's unscoped `/usagePi`, which returns
    // all clients' rows for a given second -- is refused here rather than
    // forwarded, so it cannot step around that scoping. routstrd removes the
    // route itself; this guard also covers daemons that still ship it.
    if (path.startsWith("/usage")) {
      return this.json({ error: "Not found." }, 404);
    }

    // Reads only: the daemon routes a POST to these paths as a paid request.
    const isPublicPath =
      (req.method === "GET" || req.method === "HEAD") &&
      AuthProxy.isPublicPath(path);

    // --- Public path: forward immediately ---
    if (isPublicPath) {
      return this.forward(req);
    }

    // --- Auth required ---
    if (!authorization) {
      return this.json({
        error:
          "Missing authentication credentials. " +
          "Use 'Authorization: Bearer sk-...', 'x-api-key: sk-...', or 'Authorization: Nostr <base64-event>'.",
      }, 401);
    }

    const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
    if (bearerMatch) {
      if (!AuthProxy.isInferencePath(req.method, path)) {
        return this.json({
          error: "API keys can access inference endpoints only. Use NIP-98 auth with the required role.",
        }, 403);
      }

      const apiKey = bearerMatch[1]!;
      const client = this.store.findByApiKey(apiKey);
      if (!client) {
        return this.json({ error: "Invalid API key." }, 401);
      }

      const clientNpub = this.resolveClientNpub(client);
      if (clientNpub) {
        const blocked = this.quotaResponse(clientNpub, req);
        if (blocked) return blocked;
      }

      // Buffer the body only when model allowlist enforcement is enabled,
      // so we can inspect the `model` field. When disabled, keep the
      // original streaming body to avoid the buffering latency.
      let body: Uint8Array | undefined;
      if (this.config.modelAllowlistEnabled) {
        body = new Uint8Array(await req.arrayBuffer());
      }

      const blocked = this.checkModelAllowlist(body, req.method);
      if (blocked) return blocked;

      // Canonicalize all API-key carriers after validation for SDK attribution.
      return this.forward(req, body, false, apiKey);
    }

    const nip98Match = authorization.match(/^Nostr\s+(.+)$/i);
    if (nip98Match) {
      // The request body stream can be consumed only once. Buffer it so NIP-98
      // can verify the payload hash and the same bytes can still be forwarded.
      const body =
        req.method === "GET" || req.method === "HEAD"
          ? undefined
          : new Uint8Array(await req.arrayBuffer());

      const requiredRole = AuthProxy.isAdminPath(req.method, path) ? "admin" : "user";
      const auth = await this.authenticateNpub(
        req,
        authorization,
        body,
        requiredRole,
      );
      if (auth instanceof Response) return auth;

      const overQuota = this.quotaResponse(auth.pubkey, req, true);
      if (overQuota) return overQuota;

      const blocked = this.checkModelAllowlist(body, req.method);
      if (blocked) return blocked;

      return this.forward(req, body);
    }

    return this.json({
      error:
        "Invalid Authorization format. Expected 'Bearer sk-...' or 'Nostr <base64-event>'.",
    }, 401);
  }

  /** Start the Bun HTTP server. */
  serve() {
    const { port, host } = this.config;
    const npubCount = this.store.countNpubs();
    console.log(`routstrd-auth proxy listening on http://${host}:${port}`);
    console.log(`  Upstream: ${this.config.upstream}`);
    console.log(`  DB path:  ${this.config.dbPath}`);
    console.log(`  Registered npubs: ${npubCount}`);
    console.log(`  Model allowlist: ${this.config.modelAllowlistEnabled ? "enabled" : "disabled"}`);
    if (npubCount === 0) {
      console.warn(
        "  Warning: no registered npub/pubkey. " +
          "The first admin can be registered without auth using POST /npubs.",
      );
    }

    const unnamed = this.store.listUnnamedNpubs();
    if (unnamed.length > 0) {
      const shown = unnamed.slice(0, 5).map((entry) => entry.npub.slice(-9)).join(", ");
      const more = unnamed.length > 5 ? ` (+${unnamed.length - 5} more)` : "";
      console.warn(
        `  Warning: ${unnamed.length} npub(s) have no display name: ${shown}${more}. ` +
          "They were bootstrapped from ROUTSTRD_AUTH_ADMIN_* or migrated from the " +
          "legacy admin table. Set one with: routstrd npubs update <npub> --name \"Alice\"",
      );
    }

    Bun.serve({
      port,
      hostname: host,
      fetch: (req, server) => {
        // LLM/SSE streams can legitimately have long quiet periods while the
        // upstream model reasons, retries, or waits on tooling. Bun's default
        // 10s idle timeout closes such in-flight requests, surfacing to clients
        // as "terminated" even when the upstream stream eventually completes.
        server.timeout(req, 0);
        return this.handle(req);
      },
    });

    // Graceful shutdown.
    process.on("SIGINT", () => {
      console.log("\nShutting down...");
      this.store.close();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      this.store.close();
      process.exit(0);
    });
  }

  // --- Exported for testing / external use ---

  close(): void {
    this.store.close();
  }

  /**
   * `*` is safe here: no cookies or sessions, so a cross-origin page cannot
   * borrow a visitor's identity, and anything non-public still needs its own key.
   */
  static CORS_HEADERS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization, X-Api-Key, Anthropic-Version, Anthropic-Beta, Content-Type, X-Cashu, X-Routstr-Model",
    "Access-Control-Expose-Headers":
      "X-Cashu, X-Routstr-Request-Id, X-Routstr-Cost-Msats, X-Routstr-Cost-Usd, X-Routstr-Input-Cost-Msats, X-Routstr-Output-Cost-Msats, X-Routstr-Quota-Limit-Sats, X-Routstr-Quota-Used-Sats, X-Routstr-Quota-Reset, Retry-After",
    "Access-Control-Max-Age": "86400",
  };

  /** Minimal public endpoints that don't require auth. */
  static PUBLIC_PATHS = new Set([
    "/health",
    "/ping",
    "/models",
    "/v1/models",
  ]);

  /** Public path prefixes. */
  static PUBLIC_PREFIXES = ["/models/", "/v1/models/"];

  /** Endpoints that are admin-only for every method. */
  static ADMIN_PATHS = new Set([
    // ── Moving value ────────────────────────────────────────────────────────
    "/wallet/send/cashu",
    "/wallet/send/bolt11",
    // Reclaims the proofs behind offline sends that were never claimed. The
    // daemon refuses it without `confirmed: true` precisely because unclaimed
    // tokens are invalidated, so it moves value like a send does.
    "/wallet/sweep-offline",
    // Re-issues paid mint quotes nobody ever claimed. It recovers money, but it
    // does so by minting against the wallet, so it is not a read.
    "/wallet/recover",
    "/wallet/recover/operations",

    // ── Wallet integrity ────────────────────────────────────────────────────
    // Gates the wallet's spending state. Without it nothing else in this list
    // is reachable anyway, so gating it is what makes the rest mean anything.
    "/wallet/unlock",
    // The only route that marks proofs spent without a matching swap, which is
    // exactly how a proof gets destroyed rather than moved.
    "/wallet/cleanup",
    // Despite the name this is not a read. With `dryRun` omitted -- the default
    // -- it asks every mint about all ready and inflight proofs and writes
    // `spent` for the ones the mint reports, which reclaims balance and, via
    // `proofs:state-changed`, finalizes send operations that had reserved those
    // inflight proofs. The CLI's "are you sure" prompt lives in the client, so
    // the proxy cannot rely on it; unlike `/wallet/sweep-offline` the daemon has
    // no `confirmed` guard here, so a bare `POST {}` applies immediately.
    "/wallet/check-proofs",

    // ── Provider credentials ────────────────────────────────────────────────
    // `GET /keys/api` returns every upstream provider key in plaintext.
    "/keys/api",
    "/keys/api/delete",
  ]);

  /**
   * Endpoints that are admin-only for some methods but readable by any
   * registered npub for others.
   *
   * routstrd answers GET and POST on the same path for its wallet resources, so
   * a path-only gate cannot express "changing this is admin work, reading it is
   * not". The mint set is the case that matters: adding a mint or moving the
   * default decides which mints the wallet trusts, but `routstrd wallet mints
   * list` must keep working for a non-admin. `/wallet/mints/info` is a
   * stateless lookup on a URL the caller supplies, so it stays off this list.
   */
  static ADMIN_METHODS: ReadonlyMap<string, ReadonlySet<string>> = new Map<
    string,
    ReadonlySet<string>
  >([
    ["/wallet/mints", new Set(["POST"])],
    ["/wallet/mints/default", new Set(["POST"])],
  ]);

  /**
   * Admin-only path prefixes, for daemon routes that carry a parameter.
   *
   * `POST /wallet/send/cashu/<operationId>/mark-spent` settles an offline send
   * (routstrd 0.5.0). It cannot live in `ADMIN_PATHS` because the operation id
   * varies, and leaving it out would put settlement below sending: a plain
   * registered npub cannot send cashu but could mark someone else's send spent.
   *
   * The trailing slash keeps `/wallet/send/cashuX` from matching.
   */
  static ADMIN_PREFIXES = ["/wallet/send/cashu/"];

  /**
   * Mirror of Routstr Core's `_ALLOWED_ENDPOINTS` (routstr/proxy.py), which is
   * the authoritative gate for which method/path pairs may reach an upstream
   * with the provider credential attached. Core refuses everything outside that
   * table, so anything listed there is safe for a client key to reach and
   * anything missing there is dead weight here. Keep the two tables in sync.
   *
   * Deliberate differences from core:
   * - `attestation` / `tee/attestation` are omitted. Core forwards those
   *   unauthenticated (`_select_unauthenticated_get_upstreams`), so they belong
   *   in `PUBLIC_PATHS`, not in a client-key capability list.
   * - `models` is listed for parity, but `PUBLIC_PATHS` already covers it, so a
   *   GET never reaches the client-key branch. It is GET-only here exactly as
   *   in core, which is why `POST /v1/models` stays a 403.
   *
   * Core also accepts operator additions via `PROXY_EXTRA_ALLOWED_PATHS`; this
   * proxy has no equivalent and rejects anything not listed below.
   */
  static INFERENCE_ENDPOINTS: ReadonlyMap<string, ReadonlySet<string>> = new Map<
    string,
    ReadonlySet<string>
  >([
    ["chat/completions", new Set(["POST"])],
    ["completions", new Set(["POST"])],
    ["responses", new Set(["POST"])],
    ["messages", new Set(["POST"])],
    // Anthropic token counting. Core's allowlist is exact, so the `messages`
    // entry above does not carry it; Claude Code and the Anthropic SDKs call it
    // before every request.
    ["messages/count_tokens", new Set(["POST"])],
    ["embeddings", new Set(["POST"])],
    ["systemone", new Set(["POST"])],
    ["decisions", new Set(["POST"])],
    ["images/generations", new Set(["POST"])],
    ["images/edits", new Set(["POST"])],
    ["images/variations", new Set(["POST"])],
    ["image/generate", new Set(["POST"])],
    ["image/edit", new Set(["POST"])],
    ["image/inpaint", new Set(["POST"])],
    ["image/upscale", new Set(["POST"])],
    ["models", new Set(["GET"])],
  ]);

  static isPublicPath(path: string): boolean {
    if (AuthProxy.PUBLIC_PATHS.has(path)) return true;
    return AuthProxy.PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix));
  }

  static isAdminPath(method: string, path: string): boolean {
    return (
      AuthProxy.ADMIN_PATHS.has(path) ||
      (AuthProxy.ADMIN_METHODS.get(path)?.has(method.toUpperCase()) ?? false) ||
      AuthProxy.ADMIN_PREFIXES.some((prefix) => path.startsWith(prefix))
    );
  }

  /**
   * Canonicalize a request path the way core's `_canonical_api_path` does:
   * drop one trailing slash, then a leading `v1/`. Callers must screen for
   * ambiguous spellings first; `/v1//x` and friends are rejected upstream of
   * this.
   */
  static canonicalApiPath(path: string): string {
    let route = path.slice(1);
    if (route.endsWith("/")) route = route.slice(0, -1);
    if (route.startsWith("v1/")) route = route.slice(3);
    return route;
  }

  static isInferencePath(method: string, path: string): boolean {
    return (
      AuthProxy.INFERENCE_ENDPOINTS.get(
        AuthProxy.canonicalApiPath(path),
      )?.has(method.toUpperCase()) ?? false
    );
  }

  /**
   * Routes that never spend from the wallet: proxy-managed npub/client/usage
   * endpoints and the daemon's own wallet, NWC, settings, provider, key and
   * control routes. Any other POST falls through to the paid inference proxy.
   */
  static NON_PAID_PREFIXES = [
    "/npubs",
    "/clients",
    "/usage",
    "/wallet",
    "/nwc",
    "/settings",
    "/providers",
    "/cooldowns",
    "/keys",
    "/stop",
    "/refund",
  ];

  /** True for requests that can incur inference spend. */
  static isPaidRequest(method: string, path: string): boolean {
    if (method !== "POST") return false;
    return !AuthProxy.NON_PAID_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    );
  }
}
