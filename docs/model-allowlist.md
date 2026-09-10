# Model Allowlist Enforcement

The auth proxy can enforce a **Routstr 21 model allowlist** (opt-in) — when enabled, only requests targeting one of the 21 approved Routstr models are forwarded to the daemon. Requests for non-whitelisted models are rejected with a `403` response before they reach the upstream. When disabled, the allowlist check is skipped and all models pass through.

## How It Works

1. The routstrd daemon's SDK fetches the Routstr 21 model list from Nostr (kind 38423 events) and stores it in the shared SQLite database under the `sdk_storage` table, key `routstr21Models`.
2. The auth proxy reads this list directly from the same DB — **zero Nostr dependency**.
3. When the allowlist is enabled, on every POST request that passes authentication, the proxy buffers the request body, parses the `model` field, and checks it against the allowlist.
4. If the model is not in the allowlist, the proxy returns `403` with the list of available models.

### Request Flow

```
Client → auth proxy (validates auth + checks model allowlist) → routstrd daemon → provider
```

The model check happens **after auth succeeds** but **before forwarding** to the daemon. This means:

- Unauthenticated requests are rejected with `401` (auth check happens first).
- Authenticated requests with a non-whitelisted model are rejected with `403`.
- Authenticated requests with a whitelisted model are forwarded normally.

## Configuration

### Enable / Disable

The allowlist is **disabled by default**. To enable it:

```bash
export ROUTSTRD_AUTH_MODEL_ALLOWLIST=true
```

When enabled, only models in the Routstr 21 allowlist are forwarded; requests for other models are rejected with a `403`. When disabled (the default), all models pass through without a model check.

## Fail-Open Behavior

If the `routstr21Models` key is not yet in the database (e.g., the daemon hasn't bootstrapped), the proxy **fails open** — all models are allowed. This prevents the proxy from blocking all traffic during startup. A warning is not logged at the proxy level (the daemon logs its own bootstrap status).

## What Gets Checked

These checks only apply when the allowlist is enabled.

- **POST requests** with a JSON body containing a `model` field — checked against the allowlist.
- **GET requests** (e.g., `/models`, `/v1/models`) — not checked (public paths, forwarded immediately).
- **Management endpoints** (`/npubs`, `/clients`, `/usage`) — not checked (routed to their own handlers before the model check).
- **Non-JSON bodies** — not checked (the proxy can't extract a model field).
- **Requests without a `model` field** — not checked (forwarded to upstream, which handles the error).

## Updating the Allowed Models List

The allowlist is updated automatically by the routstrd daemon:

1. The daemon's `ModelManager.fetchRoutstr21Models()` fetches kind 38423 Nostr events from the Routstr pubkey.
2. The fetched model list is persisted to the shared SQLite DB under key `routstr21Models`.
3. The auth proxy reads the latest value on every request (no caching) — changes are picked up immediately.


## Performance

- Reading the allowlist from SQLite is a single key lookup (`SELECT value FROM sdk_storage WHERE key = 'routstr21Models'`) — typically <1ms.
- When the allowlist is enabled, the request body is buffered for POST requests. This adds a small latency cost compared to streaming, but is necessary to inspect the `model` field. Response streaming (SSE/LLM streaming) is unaffected — only the request body is buffered.
- Model ID comparison is case-sensitive, matching how model IDs are stored in the allowlist.
