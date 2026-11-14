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

function getAbsoluteRequestUrl(req: Request): string {
  // Bun's Request.url is already absolute. Honor common reverse-proxy headers so
  // deployments behind TLS/load-balancers can validate the public URL clients
  // actually signed.
  const url = new URL(req.url);
  const forwardedProto = firstHeaderValue(req.headers.get("x-forwarded-proto"));
  const forwardedHost = firstHeaderValue(req.headers.get("x-forwarded-host"));
  const host = firstHeaderValue(req.headers.get("host"));

  if (forwardedProto) url.protocol = forwardedProto.endsWith(":")
    ? forwardedProto
    : `${forwardedProto}:`;
  if (forwardedHost || host) url.host = forwardedHost ?? host!;

  return url.toString();
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
 * Validate an `Authorization: Nostr ...` request according to NIP-98.
 *
 * The signed event must bind to the exact public request URL and method. If the
 * request has a non-empty body, a `payload` tag containing the SHA-256 hex hash
 * of the raw request body is required and must match.
 */
export async function validateNIP98Request(
  authorization: string,
  req: Request,
  body?: Uint8Array,
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
  if (urlTag !== getAbsoluteRequestUrl(req)) {
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

  // The signature alone does not stop a captured request being replayed inside
  // the freshness window. Record the id for as long as an event could still be
  // accepted, and refuse a second presentation of it.
  const nowSeconds = Math.round(Date.now() / 1000);
  if (seenEvents.has(event.id)) {
    throw new Error("NIP-98 event has already been used.");
  }
  if (seenEvents.size >= SEEN_EVENTS_MAX) pruneSeenEvents(nowSeconds);
  seenEvents.set(event.id, nowSeconds + SEEN_EVENTS_TTL_SECONDS);

  return { pubkey: event.pubkey, event };
}

/**
 * Event ids accepted recently, mapped to the second they stop mattering.
 * A NIP-98 event is only valid for `NIP98_MAX_AGE_SECONDS` either side of
 * `created_at`, so anything older than that plus the window cannot be replayed
 * anyway and the entry can go.
 */
const seenEvents = new Map<string, number>();
const SEEN_EVENTS_TTL_SECONDS = NIP98_MAX_AGE_SECONDS * 2 + 5;
const SEEN_EVENTS_MAX = 4096;

function pruneSeenEvents(nowSeconds: number): void {
  for (const [id, expiresAt] of seenEvents) {
    if (expiresAt <= nowSeconds) seenEvents.delete(id);
  }
}

/** Test hook: forget every recorded event id. */
export function resetNip98ReplayCache(): void {
  seenEvents.clear();
}

export function isNIP98Authorization(authorization: string | null): boolean {
  return Boolean(authorization?.match(/^Nostr\s+.+$/i));
}
