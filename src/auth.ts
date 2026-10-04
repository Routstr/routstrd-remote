import { validateNIP98Request } from "./nip98";
import type { Client } from "./store";

/**
 * Public endpoints that don't require auth.
 * Everything else is default-deny and requires Bearer or NIP-98 auth.
 */
const PUBLIC_PATHS = new Set([
  "/health",
  "/ping",
  "/models",
  "/v1/models",
]);

const PUBLIC_PREFIXES = ["/models/", "/v1/models/"];

/** Authorization takes precedence, including malformed or invalid credentials.
 * Only requests without that header may use Anthropic's x-api-key carrier.
 */
export function requestAuthorization(req: Request): string | null {
  const authorization = req.headers.get("authorization");
  if (authorization !== null) return authorization;
  const apiKey = req.headers.get("x-api-key")?.trim();
  return apiKey ? `Bearer ${apiKey}` : null;
}

export interface AuthResult {
  authenticated: boolean;
  client?: Client;
  nostrPubkey?: string;
  // If true, the path is public and no auth is needed.
  isPublicPath: boolean;
}

export function isPublicPath(path: string): boolean {
  if (PUBLIC_PATHS.has(path)) return true;
  return PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Determine if a path needs auth and validate the Bearer token.
 *
 * Kept for compatibility with callers that only need synchronous Bearer auth.
 * The proxy itself also supports NIP-98 because that requires request URL/body
 * validation and is therefore asynchronous.
 */
export function authenticate(
  authorization: string | null,
  path: string,
  hasClients: boolean,
  findClient: (apiKey: string) => Client | null,
): AuthResult {
  // Check if the path is public.
  if (isPublicPath(path)) {
    return { authenticated: true, isPublicPath: true };
  }

  // --- Auth required from here ---

  if (!authorization) {
    return { authenticated: false, isPublicPath: false };
  }

  const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
  if (!bearerMatch) {
    return { authenticated: false, isPublicPath: false };
  }

  const apiKey = bearerMatch[1]!;
  const client = findClient(apiKey);
  if (!client) {
    return { authenticated: false, isPublicPath: false };
  }

  return { authenticated: true, isPublicPath: false, client };
}

/**
 * Full auth helper that supports Bearer and NIP-98.
 */
export async function authenticateRequest(
  req: Request,
  path: string,
  hasClients: boolean,
  findClient: (apiKey: string) => Client | null,
  body?: Uint8Array,
): Promise<AuthResult> {
  if (isPublicPath(path)) {
    return { authenticated: true, isPublicPath: true };
  }

  const authorization = requestAuthorization(req);
  if (!authorization) {
    return { authenticated: false, isPublicPath: false };
  }

  const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch) {
    const client = findClient(bearerMatch[1]!);
    return client
      ? { authenticated: true, isPublicPath: false, client }
      : { authenticated: false, isPublicPath: false };
  }

  if (authorization.match(/^Nostr\s+(.+)$/i)) {
    try {
      const { pubkey } = await validateNIP98Request(authorization, req, body);
      return { authenticated: true, isPublicPath: false, nostrPubkey: pubkey };
    } catch {
      return { authenticated: false, isPublicPath: false };
    }
  }

  return { authenticated: false, isPublicPath: false };
}
