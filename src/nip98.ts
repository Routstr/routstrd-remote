import { verifyEvent, type Event } from "nostr-tools";

export const NIP98_KIND = 27235;
export const NIP98_MAX_AGE_SECONDS = 60;

export interface NIP98ValidationResult {
  pubkey: string;
  event: Event;
}

function base64UrlToBase64(input: string): string {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = base64.length % 4;
  return padding === 0 ? base64 : base64 + "=".repeat(4 - padding);
}

function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.byteLength !== bBytes.byteLength) return false;

  let diff = 0;
  for (let i = 0; i < aBytes.byteLength; i++) {
    diff |= aBytes[i]! ^ bBytes[i]!;
  }
  return diff === 0;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function getTag(event: Event, name: string): string | null {
  return event.tags.find((tag) => tag[0] === name)?.[1] ?? null;
}

function firstHeaderValue(value: string | null): string | null {
  return value?.split(",", 1)[0]?.trim() || null;
}

/**
 * The URL a NIP-98 event must have signed.
 *
 * `ROUTSTRD_AUTH_PUBLIC_URL` wins when it is set: the signed `u` tag then binds
 * to a value the operator controls, and the forwarding headers below are not
 * consulted at all. Without it we fall back to the request's own URL, patched
 * with `x-forwarded-*` so deployments behind TLS/load-balancers can validate
 * the URL clients actually signed.
 *
 * That fallback trusts headers the caller supplies. A proxy that appends rather
 * than replaces them (or direct access to the app port) lets a caller present
 * any host it likes, which defeats the binding and turns a NIP-98 event signed
 * for some other service into a credential here. Set the variable wherever the
 * proxy does not overwrite these headers itself.
 */
function getAbsoluteRequestUrl(req: Request, publicUrl?: string | null): string {
  const url = new URL(req.url);

  if (publicUrl) {
    return new URL(`${url.pathname}${url.search}`, publicUrl).toString();
  }

  const forwardedProto = firstHeaderValue(req.headers.get("x-forwarded-proto"));
  const forwardedHost = firstHeaderValue(req.headers.get("x-forwarded-host"));
  const host = firstHeaderValue(req.headers.get("host"));

  // Rebuild rather than assigning `url.host`: the host setter keeps the
  // original port when the new value has none, so a forwarded host of
  // "routstr.example.com" would otherwise produce
  // "https://routstr.example.com:8008/..." and reject every correctly signed
  // event from a proxy that talks to us on an internal port.
  const proto = (forwardedProto ?? url.protocol).replace(/:$/, "");
  const authority = forwardedHost ?? host ?? url.host;

  try {
    return new URL(`${proto}://${authority}${url.pathname}${url.search}`).toString();
  } catch {
    throw new Error("Invalid forwarding headers for NIP-98 URL binding.");
  }
}

function decodeAuthorizationEvent(authorization: string): Event {
  const match = authorization.match(/^Nostr\s+(.+)$/i);
  if (!match) {
    throw new Error("Invalid Authorization format. Expected 'Nostr <base64-event>'.");
  }

  const token = base64UrlToBase64(match[1]!.trim());
  let json: string;
  try {
    json = atob(token);
  } catch {
    throw new Error("Invalid NIP-98 token encoding.");
  }

  let event: unknown;
  try {
    event = JSON.parse(json);
  } catch {
    throw new Error("Invalid NIP-98 event JSON.");
  }

  if (!event || typeof event !== "object") {
    throw new Error("Invalid NIP-98 event.");
  }

  return event as Event;
}

/**
 * Validate an `Authorization: Nostr *** request according to NIP-98.
 *
 * The signed event must bind to the exact public request URL and method. If the
 * request has a non-empty body, a `payload` tag containing the SHA-256 hex hash
 * of the raw request body is required and must match.
 *
 * Pass `publicUrl` (from `ROUTSTRD_AUTH_PUBLIC_URL`) to bind the `u` tag to a
 * configured origin instead of trusting the request's forwarding headers.
 */
export async function validateNIP98Request(
  authorization: string,
  req: Request,
  body?: Uint8Array,
  publicUrl?: string | null,
): Promise<NIP98ValidationResult> {
  const event = decodeAuthorizationEvent(authorization);

  if (event.kind !== NIP98_KIND) {
    throw new Error("Invalid NIP-98 event kind.");
  }

  if (!Number.isFinite(event.created_at)) {
    throw new Error("Invalid NIP-98 timestamp.");
  }

  const now = Math.round(Date.now() / 1000);
  const age = now - event.created_at;
  if (age > NIP98_MAX_AGE_SECONDS || age < -NIP98_MAX_AGE_SECONDS) {
    throw new Error("NIP-98 event timestamp is outside the allowed window.");
  }

  const urlTag = getTag(event, "u");
  if (urlTag !== getAbsoluteRequestUrl(req, publicUrl)) {
    throw new Error("NIP-98 URL tag does not match this request.");
  }

  const methodTag = getTag(event, "method");
  if (!methodTag || methodTag.toLowerCase() !== req.method.toLowerCase()) {
    throw new Error("NIP-98 method tag does not match this request.");
  }

  if (body && body.byteLength > 0) {
    const payloadTag = getTag(event, "payload");
    if (!payloadTag) {
      throw new Error("NIP-98 payload tag is required for requests with a body.");
    }

    const bodyHash = await sha256Hex(body);
    if (!timingSafeEqual(payloadTag.toLowerCase(), bodyHash)) {
      throw new Error("NIP-98 payload tag does not match the request body hash.");
    }
  }

  if (!verifyEvent(event)) {
    throw new Error("Invalid NIP-98 event signature.");
  }

  return { pubkey: event.pubkey, event };
}

export function isNIP98Authorization(authorization: string | null): boolean {
  return Boolean(authorization?.match(/^Nostr\s+.+$/i));
}
