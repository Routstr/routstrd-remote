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
| `ROUTSTRD_AUTH_BOOTSTRAP_TOKEN` | generated | One-time token required to claim the first admin while no npub is registered |
| `ROUTSTRD_DIR` | `~/.routstrd` | Base config directory |

## First admin registration

Starting the auth proxy does **not** automatically register the identity in `config.json` as an admin. A fresh instance has no npub at all, so the proxy generates a one-time bootstrap token and prints it at startup. Every claim of the first admin must carry that token.

Copy the token from the app log (Cloudron: the app's **Logs** tab, or `docker logs <container>`):

```
Warning: no registered npub/pubkey. The first admin must be claimed with this one-time token:

    q3Vt...8kQ

  Send it as the x-routstr-bootstrap-token header along with the npub, e.g.:
    curl -X POST https://<your-app>/npubs -H 'Content-Type: application/json'
    -H 'x-routstr-bootstrap-token: q3Vt...8kQ'
    -d '{"npub":"npub1...","name":"Your Name"}'
```

Then claim it (the first claim becomes an admin by default):

```bash
curl -X POST "$AUTH_URL/npubs" \
  -H 'Content-Type: application/json' \
  -H 'x-routstr-bootstrap-token: <token from the log>' \
  -d '{"npub":"npub1...","name":"Alice"}'
```

The token is **single-use**: the first successful claim voids it, and the window closes for good once any npub exists. A rejected claim (bad JSON, missing `name`) does not void it. Set `ROUTSTRD_AUTH_BOOTSTRAP_TOKEN` yourself to choose the value instead; it is then not printed to the log.

Without this, the window would be open to the internet: the app is publicly reachable the moment Cloudron finishes installing it, and the first admin can send wallet funds and read every provider credential. The token is what makes "install now, configure later" safe.

`routstrd npubs register` does not send this header, so the *first* admin is claimed with the `curl` above. Once an npub is registered, `GET /npubs` and `POST /npubs` go back to NIP-98 from an existing admin and the CLI works as before.

If you delete every npub, the table is empty again and the proxy starts a new instance with no token (it only mints one while there is a window to protect). Restart the app to mint and log a new token, or set `ROUTSTRD_AUTH_BOOTSTRAP_TOKEN` and restart.

## Cloudron

[Cloudron](https://www.cloudron.io/) runs the routstrd server. Team members connect to it as clients using the `routstrd` CLI.

### Initial Setup (first person)

```bash
# Install the CLI client globally
bun i -g routstrd

# Connect to your Cloudron instance (this prints your npub)
routstrd remote <cloudron-url>

# Register yourself as the first admin. This one step uses curl because the
# CLI does not send the bootstrap token; copy the token from the app's Logs tab.
curl -X POST "https://<cloudron-url>/npubs" \
  -H 'Content-Type: application/json' \
  -H 'x-routstr-bootstrap-token: <token from the app log>' \
  -d '{"npub":"<your npub>","name":"Alice"}'
```

The first npub registered this way gets `admin` by default. After that, `routstrd npubs list`, `add` and `update` work from the CLI as usual.

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
  - wallet integrity: `POST /wallet/unlock`, `/wallet/cleanup`, `/wallet/check-proofs`, and the mint setters `POST /wallet/mints` and `/wallet/mints/default` (the `GET` reads and `/wallet/mints/info` stay open to any registered npub). `check-proofs` is not a read despite the name: it marks mint-reported proofs spent, which reclaims balance and finalizes reserved sends
  - provider API-key listing and deletion
- **Registered npubs** — stored in the shared `routstr.db` table `routstr_auth_npubs`. Env-configured admins are bootstrapped into that table at startup. Removing a pubkey from `ROUTSTRD_AUTH_ADMIN_NPUBS` **takes admin away but keeps the registration**: on the next start the row becomes an ordinary `user` (`source` flips from `env` to `api`, name and monthly limit are kept), so the npub's existing API keys keep working and the npub table never empties out and re-opens the first-admin bootstrap. A startup warning names every npub this happened to. To revoke the npub completely, use `DELETE /npubs/<npub>`; to keep it as an admin managed in the database, `PATCH /npubs` it with `role: "admin"`. Listing a pubkey in the variable always makes it an env-managed admin, even if it was registered through the API before. The exception is a pubkey on the retirement list in `src/store.ts`, which is deleted outright — that list exists for known-compromised admins such as the default `docker-entrypoint.sh` used to ship, and adding to it is a permanent, deliberate act.
- **List npubs** — `GET /npubs` returns `{ "npubs": [...] }` with each npub's `npub`, `name`, `role`, `monthlyLimitSats` (`null` = unlimited), plus a top-level `monthlyResetAt` (Unix seconds). Admins also get every npub's `monthlyUsedSats`; a member only gets their own. Requires NIP-98 auth from a registered npub.
- **Add npubs** — `POST /npubs` with `{ "npub": "npub1..." }` or `{ "pubkey": "<64-char hex>" }`, optionally `{ "role": "user", "name": "Alice", "monthlyLimitSats": 5000 }`. If no npubs are configured yet, this first add requires the one-time bootstrap token in the `x-routstr-bootstrap-token` header (see [First admin registration](#first-admin-registration)); after that it requires NIP-98 auth from an existing admin. Duplicate npubs return `409`; use `PATCH /npubs` to update an existing entry.
- **Body limits** — the npub and client management routes accept at most 1 MiB of JSON and answer `413` beyond that. Credentials are checked before the body is read, so an unauthenticated caller cannot make the proxy buffer a payload.
- **Update npubs** — `PATCH /npubs` with `{ "npub": "npub1..." }` or `{ "pubkey": "<64-char hex>" }` plus `role`, `name` and/or `monthlyLimitSats`. Requires NIP-98 auth from an existing admin. Set `name` to `null` to clear it and `monthlyLimitSats` to `null` to remove the monthly cap.
- **Monthly spend cap** — paid requests are checked against the npub's cap and return `402` with `code: "monthly_quota_exceeded"` and `X-Routstr-Quota-*` headers once it is reached. See [Monthly spend limits per npub](#monthly-spend-limits-per-npub).
- **Remove npubs** — `DELETE /npubs/<npub-or-pubkey>` (or `DELETE /npubs?npub=...`) requires NIP-98 auth from an existing admin. Removal takes effect on the next request: every API key whose recorded owner is that npub is refused with `403` and `code: "client_owner_not_registered"` until the npub is registered again, so removing a member also stops the clients they already created. The keys themselves stay in the daemon's storage. Clients created before owner attribution existed record no owner and are unaffected, because the id suffix is the only signal they carry; the proxy warns at startup about keys whose recorded owner is missing.
- **Forwarded headers** — the proxy strips `Authorization` and injects `x-routstr-client-id` so the daemon knows which client made the request.

## License

MIT
