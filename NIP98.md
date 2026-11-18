# NIP-98: HTTP Authentication

> **Status:** Draft | Optional

NIP-98 defines a mechanism for authenticating HTTP requests using Nostr events. Instead of passwords, API keys, or OAuth tokens, clients sign an ephemeral Nostr event containing the request details, and servers verify the signature to establish the client's Nostr identity.

## Motivation

Services built on Nostr often need to authenticate users on standard HTTP APIs (file storage, relay access, data services). NIP-98 provides:

- **Passwordless auth** — no credentials to manage or leak
- **User-owned identity** — tied to the user's Nostr keypair
- **Request binding** — auth is scoped to a specific URL and method
- **Payload integrity** — optional body hash prevents tampering

## How It Works

### 1. Client Creates Auth Event

The client builds a `kind 27235` event (named after [RFC 7235](https://www.rfc-editor.org/rfc/rfc7235), the HTTP Authentication standard):

```json
{
  "id": "<64-char hex>",
  "pubkey": "63fe6318dc58583cfe16810f86dd09e18bfd76aabc24a0081ce2856f330504ed",
  "content": "",
  "kind": 27235,
  "created_at": 1682327852,
  "tags": [
    ["u", "https://api.example.com/upload"],
    ["method", "POST"],
    ["payload", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"]
  ],
  "sig": "5ed9d8ec958bc854f997bdc24ac337d005af372324747efe4a00e24f4c30437ff4..."
}
```

**Required tags:**
| Tag | Description |
|-----|-------------|
| `u` | Absolute URL (including query params) of the request target |
| `method` | HTTP method (GET, POST, PUT, PATCH, DELETE) |

**Optional tags:**
| Tag | Description |
|-----|-------------|
| `payload` | SHA-256 hex hash of the request body (recommended for POST/PUT/PATCH) |

### 2. Client Signs and Sends

The client signs the event with their Nostr private key, base64-encodes the JSON, and sends it in the HTTP header:

```
Authorization: Nostr eyJpZCI6ImZlOTY0ZTc1ODkwMzM2MGYyOGQ4NDI0ZDA5MmRhODQ5NGVkMjA3Y2JhODIzMTEwYmUzYTU3ZGZlNGI1Nzg3MzQiLCJwdWJrZXkiOiI2M2ZlNjMxOGRjNTg1ODNjZmUxNjgxMGY4NmRkMDllMThiZmQ3NmFhYmMyNGEwMDgxY2UyODU2ZjMzMDUwNGVkIiwiY29udGVudCI6IiIsImtpbmQiOjI3MjM1LCJjcmVhdGVkX2F0IjoxNjgyMzI3ODUyLCJ0YWdzIjpbWyJ1IiwiaHR0cHM6Ly9hcGkuc25vcnQuc29jaWFsL2FwaS92MS9uNXNwL2xpc3QiXSxbIm1ldGhvZCIsIkdFVCJdXSwic2lnIjoiNWVkOWQ4ZWM5NThiYzg1NGY5OTdiZGMyNGFjMzM3ZDAwNWFmMzcyMzI0NzQ3ZWZlNGEwMGUyNGY0YzMwNDM3ZmY0ZGQ4MzA4Njg0YmVkNDY3ZDlkNmJlM2U1YTUxN2JiNDNiMTczMmNjN2QzMzk0OWEzYWFmODY3MDVjMjIxODQifQ
```

### 3. Server Validates

The server performs these checks **in order**:

1. **Kind check** — event must be `kind 27235`
2. **Timestamp check** — `created_at` must be within ~60 seconds of current time
3. **URL check** — `u` tag must match the absolute request URL exactly
4. **Method check** — `method` tag must match the HTTP method used
5. **Payload check** *(optional)* — if body present, `payload` tag hash must match
6. **Signature check** — verify the event signature using the `pubkey`

If any check fails, respond with `401 Unauthorized`.

### 4. Server Identifies User

On success, the server extracts the `pubkey` from the event — this is the user's Nostr identity. The server can then:
- Look up user data by pubkey
- Apply per-pubkey rate limits or quotas
- Store/associate resources with the user's pubkey

## Security Properties

| Property | How It's Achieved |
|----------|-------------------|
| **Replay protection** | Fresh timestamp plus single-use event IDs in this proxy instance (except empty-table bootstrap reads) |
| **No request hijacking** | URL and method are bound to the signed event |
| **No payload tampering** | Optional SHA-256 hash of body |
| **No credential storage** | Server only needs the user's pubkey |
| **Ephemeral tokens** | Each request gets a fresh signature |

## Use Cases

### Blossom (File Storage)
Blossom servers use NIP-98 to authenticate file uploads and deletions, tying stored media to a specific Nostr pubkey.

### API Quotas
Services can enforce per-pubkey rate limits and upload quotas without maintaining their own account system.

### Relay Access
NIP-98 can replace API keys for accessing HTTP-based Nostr relays.

## Comparison with Bearer Tokens

| Aspect | Bearer Token (API Key) | NIP-98 |
|--------|------------------------|--------|
| Identity | Shared secret | User's Nostr keypair |
| Rotation | Manual or periodic | Automatic (user controls keys) |
| Revocation | Server-side only | User can rotate keys |
| Request binding | None | URL + method + payload |
| Client complexity | Low | Higher (requires Nostr signing) |
| Privacy | Token can be scoped | Full Nostr identity exposed |

## Reference Implementation (Client)

```typescript
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { base64 } from '@scure/base'

const HTTPAuth = 27235

async function getToken(
  url: string,
  method: string,
  sign: (event: any) => Promise<any>,  // Nostr signing function
  payload?: any,
): Promise<string> {
  const event = {
    kind: HTTPAuth,
    tags: [
      ['u', url],
      ['method', method],
      ['nonce', crypto.randomUUID()], // unique even for identical same-second requests
    ],
    created_at: Math.round(Date.now() / 1000),
    content: '',
  }

  if (payload) {
    const hash = sha256(new TextEncoder().encode(JSON.stringify(payload)))
    event.tags.push(['payload', bytesToHex(hash)])
  }

  const signed = await sign(event)
  return 'Nostr ' + base64.encode(new TextEncoder().encode(JSON.stringify(signed)))
}
```

## Reference Implementation (Server)

```typescript
async function validateNIP98(authHeader: string, url: string, method: string, body?: any): Promise<string> {
  // 1. Decode the event
  const token = authHeader.replace('Nostr ', '')
  const event = JSON.parse(new TextDecoder().decode(base64.decode(token)))

  // 2. Verify signature
  if (!verifyEvent(event)) throw new Error('Invalid signature')

  // 3. Check kind
  if (event.kind !== 27235) throw new Error('Wrong event kind')

  // 4. Check timestamp (60s window)
  const age = Math.round(Date.now() / 1000) - event.created_at
  if (age > 60 || age < -60) throw new Error('Timestamp out of range')

  // 5. Check URL
  const urlTag = event.tags.find(t => t[0] === 'u')?.[1]
  if (urlTag !== url) throw new Error('URL mismatch')

  // 6. Check method
  const methodTag = event.tags.find(t => t[0] === 'method')?.[1]
  if (methodTag?.toLowerCase() !== method.toLowerCase()) throw new Error('Method mismatch')

  // 7. Check payload hash if body present
  if (body && Object.keys(body).length > 0) {
    const payloadTag = event.tags.find(t => t[0] === 'payload')?.[1]
    const hash = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(body))))
    if (payloadTag !== hash) throw new Error('Payload hash mismatch')
  }

  // Success — return the user's pubkey
  return event.pubkey
}
```

## Libraries

| Language | Library | NIP-98 Support |
|----------|---------|----------------|
| TypeScript | [nostr-tools](https://github.com/nbd-wtf/nostr-tools) | `nip98.ts` |
| Rust | [nostr-sdk](https://github.com/rust-nostr/nostr) | `nip98` module |
| Python | [nostr-sdk-py](https://github.com/rust-nostr/nostr-sdk-py) | Via SDK |
| C# | Community | [NostrAuth.cs](https://gist.github.com/v0l/74346ae530896115bfe2504c8cd018d3) |

## Specification

See [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md) on the Nostr NIPs repository for the official specification.

---

## Relation to This Project

This auth proxy (`routstrd-auth`) currently uses **Bearer token authentication** with API keys stored in SQLite. NIP-98 could be integrated as an alternative authentication mechanism, allowing users to authenticate using their Nostr keypair instead of a traditional API key.

**Potential integration points:**
- Accept `Authorization: Nostr <base64-event>` header alongside `Authorization: Bearer sk-...`
- Extract `pubkey` from validated NIP-98 event as the client identifier
- Maintain backward compatibility with existing Bearer token flow

## Proxy single-use contract and rollout

Sign a fresh event with a random `nonce` tag for every HTTP request. A fresh
signature alone does not change an event ID: identical signed fields within one
second hash to the same ID. Additional tags are accepted without requiring a
specific nonce tag. Exact event reuse returns `401 nip98_replayed`.

After registration and role authorization, the proxy consumes the ID before the
action. Later application failures still consume it. Empty-table `GET /npubs` is
read-only and deliberately exempt. The bounded, per-proxy in-memory cache retains
IDs for 125 seconds; it does not survive restarts or protect across instances.
Capacity exhaustion returns `503 replay_cache_saturated` and `Retry-After`, never
evicts a still-valid ID. See README for capacity sizing and clock policy.
Re-signing a retry is not operation-level idempotency: do not automatically retry
wallet sends after ambiguous responses.

Release this guard only after shipping routstrd signer commit `9a60f13` in the
bundled daemon. Its [NGIT PR](https://njump.me/nevent1qqsxq8l8fgkr60frayjd3gwa8ercyk56nhwvw93rflk2ql2yc8wweegpz3mhxue69uhhyetvv9ujumn8d96zuer9wcntsqtw)
is available, but no daemon release or bundled-version bump is made by this PR.
