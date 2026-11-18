/** Reviewed against routstrd's pinned HTTP dispatcher. `:param` matches exactly
 * one nonempty URL path segment, without decoding it (model ids can contain
 * an encoded slash). Do not replace these patterns with prefix matches. */
export type RouteAccess = "public" | "member" | "admin" | "inference" | "proxy" | "unsupported";
interface DaemonRoute { method: string; path: string; access: RouteAccess }

function routes(access: RouteAccess, method: string, ...paths: string[]): DaemonRoute[] {
  return paths.map(path => ({ method, path, access }));
}

// These are provider operations, not arbitrary POSTs. Keep the existing Core
// method/path contract, including its optional v1/ prefix and trailing slash.
const inferenceFamilies = [
  "chat/completions", "completions", "responses", "messages", "messages/count_tokens",
  "embeddings", "systemone", "decisions", "images/generations", "images/edits",
  "images/variations", "image/generate", "image/edit", "image/inpaint", "image/upscale",
];

export const DAEMON_ROUTES: readonly DaemonRoute[] = [
  ...routes("public", "GET", "/health", "/ping", "/models", "/v1/models",
    "/models/:model/providers", "/models/:model/paths"),
  ...routes("public", "HEAD", "/v1/models"),

  // These routes must go through the proxy's ownership/scoping handlers,
  // never its generic NIP-98 or public forwarding path.
  ...routes("proxy", "GET", "/clients", "/usage", "/usage/summary"),
  ...routes("proxy", "POST", "/clients/add", "/clients/delete"),

  // Grant only the reviewed operations, not other methods on the same paths.
  ...routes("member", "GET", "/status", "/version", "/wallet/status", "/wallet/balance",
    "/wallet/receive/bolt11/:quoteId", "/wallet/mints", "/wallet/mints/default", "/wallet/history",
    "/wallet/npc/address", "/nwc/status", "/settings/auto-model-path", "/balance", "/keys/balance",
    "/providers", "/cooldowns", "/providers/reviews", "/requests", "/requests/:requestId"),
  ...routes("member", "POST", "/wallet/receive/cashu", "/wallet/receive/bolt11", "/wallet/mints/info",
    "/wallet/npc/username", "/wallet/npc/sync", "/nwc/connect", "/nwc/disconnect", "/nwc/fund",
    "/nwc/auto-refill", "/settings/auto-refresh", "/settings/auto-model-path", "/stop", "/refund",
    "/refund/xcashu", "/providers/disable", "/providers/enable", "/providers/nostr-sync", "/cooldowns/reset"),

  // Moving/settling value, changing wallet trust or integrity, or handling
  // provider secrets requires an administrator (including check-proofs, which
  // mutates proofs by default, and recover, which reissues paid mint quotes).
  ...routes("admin", "GET", "/keys/api"),
  ...routes("admin", "DELETE", "/keys/api/delete"),
  ...routes("admin", "POST", "/keys/api/delete", "/wallet/unlock", "/wallet/sweep-offline", "/wallet/cleanup",
    "/wallet/check-proofs", "/wallet/recover", "/wallet/recover/operations", "/wallet/send/cashu",
    "/wallet/send/cashu/:operationId/mark-spent", "/wallet/send/bolt11", "/wallet/mints", "/wallet/mints/default"),

  ...routes("inference", "POST", ...inferenceFamilies.flatMap(family =>
    [`/${family}`, `/v1/${family}`, `/${family}/`, `/v1/${family}/`])),
];

const exactRoutes = new Map<string, RouteAccess>();
const parameterRoutes: { method: string; segments: string[]; access: RouteAccess }[] = [];
for (const { method, path, access } of DAEMON_ROUTES) {
  const segments = path.split("/");
  if (segments.some(s => s.startsWith(":"))) parameterRoutes.push({ method, segments, access });
  else exactRoutes.set(`${method} ${path}`, access);
}

/** No default role: an unknown operation is not a member capability. */
export function classifyDaemonRoute(method: string, path: string): RouteAccess | undefined {
  const verb = method.toUpperCase();
  const exact = exactRoutes.get(`${verb} ${path}`);
  if (exact) return exact;
  const segments = path.split("/");
  return parameterRoutes.find(pattern => pattern.method === verb && pattern.segments.length === segments.length &&
    pattern.segments.every((s, i) => s.startsWith(":") ? segments[i] !== "" : s === segments[i]))?.access;
}
