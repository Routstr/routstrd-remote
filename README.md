# routstrd-auth

Standalone **auth proxy** for [routstrd](https://github.com/routstr/routstrd). Sits in front of the daemon, validates `Authorization: Bearer sk-...` tokens, and forwards requests.

## Why?

Keeps auth as a separate, replaceable layer. The daemon itself runs unauthenticated on localhost only; the proxy is the public-facing gatekeeper.

## Architecture

```
┌─────────────┐      ┌──────────────────┐      ┌──────────────┐
│   Clients   │ ───► │  routstrd-auth   │ ───► │  routstrd    │
│ (CLI, Pi,   │      │  :8008 (public)  │      │  :8009 (local)│
│  OpenCode)  │      │  Bearer token    │      │  No auth     │
└─────────────┘      └──────────────────┘      └──────────────┘
```

## Configuration

All values have sensible defaults and can be overridden via environment variables or CLI flags.

| Variable | Default | Description |
|----------|---------|-------------|
| `ROUTSTRD_AUTH_PORT` | `8008` | Public port |
| `ROUTSTRD_AUTH_HOST` | `0.0.0.0` | Bind host |
| `ROUTSTRD_UPSTREAM` | `http://localhost:8009` | Upstream routstrd URL |
| `ROUTSTRD_DB_PATH` | `~/.routstrd/routstr.db` | Shared SQLite DB |
| `ROUTSTRD_AUTH_MODEL_ALLOWLIST` | `false` | Enable model allowlist enforcement (`true`/`false`) |
| `ROUTSTRD_DIR` | `~/.routstrd` | Base config directory |

## First admin registration

Starting the auth proxy does **not** automatically register the identity in `config.json` as an admin. Register explicitly when you are ready:

```bash
# From inside the container (or its Cloudron terminal)
routstrd npubs register --name "Alice"

# Alternatively, from the Docker host
docker exec -it <container> routstrd npubs register --name "Alice"
```

A display name is required — it is how the admin list tells identities apart. Omit `--name` on a terminal and the CLI prompts for it; in a script, pass it explicitly. The proxy rejects a registration that carries no name, so if `--name` is not recognised, update the CLI first (`npm i -g routstrd@latest`).

No npub argument is needed: the CLI derives your npub from the `nsec` in its selected `config.json`. Inside the container this uses the container identity; on another machine it uses that machine's configured identity and auth URL.

When no npubs are registered, `GET /npubs` accepts a valid NIP-98 request so the CLI can check the empty list before registering. The first `POST /npubs` is unauthenticated and defaults to admin; later additions require an existing admin. This bootstrap is **not container-only**: anyone who can reach the endpoint can claim the first-admin slot while the store is empty. Restrict access until registration is complete.

If an admin is already configured (including via `ROUTSTRD_AUTH_ADMIN_*`), use that admin to add other identities with `routstrd npubs add <npub>`.

## Cloudron

[Cloudron](https://www.cloudron.io/) runs the routstrd server. Team members connect to it as clients using the `routstrd` CLI.

### Initial Setup (first person)

```bash
# Install the CLI client globally
bun i -g routstrd

# Connect to your Cloudron instance
routstrd remote <cloudron-url>

# Register yourself as the first admin (first npub gets admin by default)
routstrd npubs register --name "Alice"
```

That's it — you now have full access to routstrd on Cloudron. Integrate it with your coding agents:

```bash
routstrd clients add --pi-agent    # for Pi Agent
routstrd clients add --claude-code # for Claude Code
# ...and more
```

### Adding Team Members

Anyone joining an existing routstrd Cloudron instance does the same initial steps:

1. `bun i -g routstrd` — install the CLI
2. `routstrd remote <cloudron-url>` — connect to the instance (this generates a unique npub for the new person)
3. Give that npub to someone who already has access
4. That person runs: `routstrd npubs add <npub>` — grants access
5. The new member can now add clients (e.g. `routstrd clients add --claude-code`) and start using routstrd

### Tracking Usage

Every team member gets their own npub, and every client they register gets a unique ID — making it easy to track team usage from the Cloudron terminal.

```bash
# Individual: see your own usage
routstrd top

# Anyone with access to the Cloudron terminal: see everything
# The clients tab shows individual usage, with the last 7 chars of each npub
# appended to client IDs for easy identification
routstrd top
```

### Monthly spend limits per npub

Admins can cap how many sats each npub may spend per calendar month. The proxy
checks the cap before forwarding a paid request and returns `402` once the npub
has reached it, so every client that member owns is blocked together.

```bash
# Cap a new team member at 5,000 sats/month
routstrd npubs add npub1... --limit-sats 5000

# Change or remove the cap later
routstrd npubs update npub1... --limit-sats 20000
routstrd npubs update npub1... --clear-limit

# See limits and current-month spend
routstrd npubs list
```

The `--limit-sats`/`--clear-limit` flags require a `routstrd` CLI release that
includes them (the proxy accepts the same fields over HTTP regardless).

The same controls are available over HTTP when you do not want to use the CLI:

```bash
# Set (or clear with null) the cap
curl -X PATCH "$AUTH_URL/npubs" -H "Authorization: Nostr <base64-event>" \
  -H 'Content-Type: application/json' \
  -d '{"npub":"npub1...","monthlyLimitSats":5000}'

# POST /npubs also accepts "monthlyLimitSats" when adding a member
curl "$AUTH_URL/npubs" -H "Authorization: Nostr <base64-event>" \
  -H 'Content-Type: application/json' \
  -d '{"npub":"npub1...","role":"user","monthlyLimitSats":5000}'
```

Semantics:

- The month follows the proxy server's local timezone (UTC in the Cloudron
  container unless `TZ` is set). Spend resets to zero at `00:00` on the first of
  each month and no admin action is needed.
- Spend is the daemon's `usage_tracking.sats_cost` for every client owned by the
  npub, attributed by `ownerNpub` and falling back to the 7-character npub
  suffix on client ids (so deleting and re-creating a client does not reset the
  total).
- The request that crosses the cap is allowed to finish — its cost is only known
  after it completes. Every following paid request is blocked until the month
  rolls over or an admin raises/clears the limit.
- Only paid inference requests (`POST` to model endpoints) are blocked.
  Wallet, client, usage, provider and npub management routes keep working, so an
  npub that is over its limit can still list clients or ask an admin for help
  (and an admin can always fix the limit).
- If monthly usage cannot be read (including a missing usage table), capped
  API-key inference returns `503` with `code: "quota_accounting_unavailable"`.
  Unlimited inference and management routes remain available. Npub list/update
  responses omit `monthlyUsedSats` when accounting is unavailable rather than
  reporting zero. Errors are logged; enforcement resumes when reads recover.
- `monthlyLimitSats: 0` blocks all paid requests. Omit it or set it to `null`
  for unlimited.
- Paid NIP-98 requests from capped npubs are rejected with `403` and
  `code: "capped_npub_requires_api_key"`, regardless of current spend. Use an
  API-key client so the daemon can account for spend. Unlimited npubs can still
  use NIP-98 inference, and management routes remain available to capped npubs.

## Usage

### Vanilla Docker

This project is intended to be run with plain Docker. Docker Compose is not required.

Build the image:

```bash
docker build -t routstrd-pro-image .
```

Run the container with a persistent bind mount:

```bash
docker run -d \
  --name routstrd-pro \
  --restart unless-stopped \
  -p 18008:8008 \
  -v $HOME/routstrd-data:/app/data \
  routstrd-pro-image
```

> **Important:** The bind mount `$HOME/routstrd-data:/app/data` is crucial for persisting data across container restarts and updates. Without this volume mount, all data will be lost when the container is removed.

The service is now available on the host at:

```bash
http://localhost:18008
```

Check the health endpoint:

```bash
curl http://localhost:18008/health
```

Follow logs:

```bash
docker logs -f routstrd-pro
```

Stop and remove the container:

```bash
docker stop routstrd-pro
docker rm routstrd-pro
```

Rebuild and restart after changes:

```bash
docker stop routstrd-pro
docker rm routstrd-pro
docker build -t routstrd-pro-image .
docker run -d \
  --name routstrd-pro \
  --restart unless-stopped \
  -p 18008:8008 \
  -v $HOME/routstrd-data:/app/data \
  routstrd-pro-image
```

> Note: `EXPOSE 8008` in the `Dockerfile` only documents the container port. Host port publishing, restart policy, container name, and volume mounting are configured with `docker run` flags.

### Local development

```bash
# Install dependencies
bun install

# Validate config & DB connectivity
bun run src/index.ts validate

# Start the proxy
bun run src/index.ts start

# Start on a different port
bun run src/index.ts start -p 8080

# Point at a custom DB
bun run src/index.ts start -d /path/to/routstr.db
```

### NIP-98 client helper

`src/nip98-client.ts` signs each request with a Nostr private key and can add a client through `/clients/add`, then fetch `/clients` and print the current list.

The private key must belong to one of the configured admin pubkeys (`ROUTSTRD_AUTH_ADMIN_NPUBS`, `ROUTSTRD_AUTH_ADMIN_PUBKEYS`, or an admin added through `POST /npubs`) because `/clients/add` is admin-only.

```bash
# Add a client, then list all clients
bun run client -- \
  --url http://localhost:8008 \
  --key nsec1... \
  --name "My Laptop"

# Or use env vars
export ROUTSTRD_AUTH_URL=http://localhost:8008
export NOSTR_NSEC=nsec1...
bun run client -- --name "My Laptop"

# Just list clients
bun run client -- --json
```

The helper creates `Authorization: Nostr <base64-event>` headers whose signed event binds the exact URL, HTTP method, and POST body hash, matching the validation in `src/nip98.ts`.

## Running alongside routstrd

1. Start routstrd on a local-only port (e.g. `8009`).
2. Start `routstrd-auth` on the public port (`8008`).
3. Clients send `Authorization: Bearer sk-...` to `:8008` as normal.

## Auth behaviour

- **Public endpoints** (`/health`, `/ping`, `/models`, `/v1/models`, and the `/models/*`, `/v1/models/*` prefixes) — forwarded immediately, no token needed. Balance routes are **not** public: they need a registered-npub NIP-98 identity.
- **Forwarded endpoints** — client API keys (`Bearer` or `x-api-key`) are limited to the method/path pairs Routstr Core's own allowlist forwards (`_ALLOWED_ENDPOINTS` in core's `routstr/proxy.py`); anything else is a `403`. That covers the inference routes (`chat/completions`, `completions`, `responses`, `messages`, `messages/count_tokens`, `embeddings`, `systemone`, `decisions`) and the image routes. Daemon state and control routes — `GET /balance`, `/keys/balance`, `/providers`, `/cooldowns`, `/status`, `/version`, `/settings/*`, `/wallet/*`, `/requests/*` — are npub-only. Registered npubs retain signed daemon access, while these require an admin npub:
  - anything that moves value: `POST /wallet/send/cashu`, `/wallet/send/bolt11`, `/wallet/sweep-offline`, `/wallet/send/cashu/<id>/mark-spent`, `/wallet/recover`, `/wallet/recover/operations`
  - wallet integrity: `POST /wallet/unlock`, `/wallet/cleanup`, and the mint setters `POST /wallet/mints` and `/wallet/mints/default` (the `GET` reads and `/wallet/mints/info` stay open to any registered npub)
  - provider API-key listing and deletion
- **Registered npubs** — stored in the shared `routstr.db` table `routstr_auth_npubs`. Env-configured admins are bootstrapped into that table at startup.
- **List npubs** — `GET /npubs` returns `{ "npubs": [...] }` with each npub's `npub`, `name`, `role`, `monthlyLimitSats` (`null` = unlimited), plus a top-level `monthlyResetAt` (Unix seconds). Admins also get every npub's `monthlyUsedSats`; a member only gets their own. Requires NIP-98 auth from a registered npub.
- **Add npubs** — `POST /npubs` with `{ "npub": "npub1..." }` or `{ "pubkey": "<64-char hex>" }`, optionally `{ "role": "user", "name": "Alice", "monthlyLimitSats": 5000 }`. If no npubs are configured yet, this first add is unauthenticated; after that it requires NIP-98 auth from an existing admin. Duplicate npubs return `409`; use `PATCH /npubs` to update an existing entry.
- **Update npubs** — `PATCH /npubs` with `{ "npub": "npub1..." }` or `{ "pubkey": "<64-char hex>" }` plus `role`, `name` and/or `monthlyLimitSats`. Requires NIP-98 auth from an existing admin. Set `name` to `null` to clear it and `monthlyLimitSats` to `null` to remove the monthly cap.
- **Monthly spend cap** — paid requests are checked against the npub's cap and return `402` with `code: "monthly_quota_exceeded"` and `X-Routstr-Quota-*` headers once it is reached. See [Monthly spend limits per npub](#monthly-spend-limits-per-npub).
- **Remove npubs** — `DELETE /npubs/<npub-or-pubkey>` (or `DELETE /npubs?npub=...`) requires NIP-98 auth from an existing admin.
- **Forwarded headers** — the proxy strips `Authorization` and injects `x-routstr-client-id` so the daemon knows which client made the request.

## License

MIT
