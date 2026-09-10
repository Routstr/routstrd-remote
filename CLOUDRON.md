# Cloudron Packaging Research for routstrd-auth

> **Date:** 2026-04-25  
> **Research scope:** How to package `routstrd-auth` (and its upstream `routstrd` daemon) for the Cloudron self-hosting platform.  
> **Sources:** [docs.cloudron.io](https://docs.cloudron.io/packaging/), [git.cloudron.io/packages](https://git.cloudron.io/packages), official tutorial repos, Cloudron forum.

---

## 1. Executive Summary

Cloudron packages apps as **single Docker containers** with a read-only root filesystem. It does **not** support `docker-compose` or multi-container apps natively. Because `routstrd-auth` is designed to sit in front of a separate `routstrd` daemon (two services), the correct Cloudron pattern is to run **both processes inside one container** using a process manager like **supervisord**.

The container exposes **one HTTP port** (the auth proxy), which Cloudron’s reverse proxy fronts with HTTPS automatically. All persistent data (SQLite DB, wallet files, configs) must live in `/app/data`, enabled via the `localstorage` addon.

---

## 2. Cloudron Platform Constraints

| Constraint | Implication for routstrd-auth |
|------------|--------------------------------|
| **Read-only filesystem** at runtime | Only `/tmp`, `/run`, and `/app/data` are writable. All code, configs baked into image must be static or symlinked. |
| **Single container per app** | `docker-compose.yml` cannot be used. Both `routstrd` and `routstrd-auth` must run in the same container. |
| **Addons for persistence & services** | SQLite DB + file storage must use the `localstorage` addon. No self-managed MySQL/PostgreSQL required. |
| **HTTP only internally** | The app must bind to plain HTTP on its `httpPort`. Cloudron handles TLS termination and certificates. |
| **Health checks** | Cloudron polls `healthCheckPath` repeatedly. The container is considered healthy only when it returns HTTP 2xx. |
| **User privileges** | `start.sh` runs as **root**, but the app processes should drop to the `cloudron` user via `gosu`. |
| **Logs** | Must go to **stdout/stderr**. Cloudron captures and rotates them. File logs should go to `/run/…/*.log` if absolutely necessary. |
| **Memory limit** | Default 256 MB. Can be raised in manifest. Should be set generously because both daemon + proxy run together. |

---

## 3. Architecture on Cloudron

```
┌──────────────────────────────────────────────────────────────┐
│                         Cloudron Box                         │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Nginx Reverse Proxy (Cloudron-managed, TLS terminated)│  │
│  └────────────────────┬───────────────────────────────────┘  │
│                       │  HTTP                                │
│  ┌────────────────────┴───────────────────────────────────┐  │
│  │  App Container (single Docker container)               │  │
│  │  ┌─────────────────┐      ┌──────────────────────┐     │  │
│  │  │  supervisord    │─────►│  routstrd            │     │  │
│  │  │  (PID 1)        │      │  localhost:8009      │     │  │
│  │  └─────────────────┘      └──────────────────────┘     │  │
│  │           │                                            │  │
│  │           └────────────────────────────────────┐       │  │
│  │                                                ▼       │  │
│  │                              ┌──────────────────────┐  │  │
│  │                              │  routstrd-auth       │  │  │
│  │                              │  0.0.0.0:8008 (http) │  │  │
│  │                              └──────────────────────┘  │  │
│  └────────────────────────────────────────────────────────┘  │
│                       │                                      │
│                       ▼                                      │
│                  /app/data (persistent, backed up)           │
│                  - routstr.db                                │
│                  - routstrd config / logs                    │
└──────────────────────────────────────────────────────────────┘
```

**Key point:** Cloudron’s external proxy talks to `routstrd-auth` on port `8008`. `routstrd-auth` talks to `routstrd` on `localhost:8009` inside the same container network namespace.

---

## 4. Required New Files

### 4.1 `CloudronManifest.json`

This file sits **next to** the Dockerfile (it is **not** baked into the image). It tells Cloudron how to install, health-check, and back up the app.

```json
{
  "id": "io.routstr.routstrd-auth",
  "title": "Routstrd Auth",
  "author": "Routstr <hello@routstr.io>",
  "description": "Auth proxy and daemon for the Routstr AI routing network",
  "tagline": "Self-hosted Routstr node with bearer-token auth",
  "version": "0.1.0",
  "upstreamVersion": "0.1.0",
  "healthCheckPath": "/health",
  "httpPort": 8008,
  "memoryLimit": 536870912,
  "addons": {
    "localstorage": {
      "sqlite": {
        "paths": ["/app/data/routstr.db"]
      }
    }
  },
  "manifestVersion": 2
}
```

**Field notes:**
- `healthCheckPath`: `/health` — matches the existing health endpoint in `routstrd-auth`.
- `httpPort`: `8008` — the public-facing port of the auth proxy. Cloudron proxies this externally.
- `memoryLimit`: 512 MB (bytes) — both Bun processes together need more than the default 256 MB.
- `addons.localstorage.sqlite.paths`: Declares the SQLite DB so Cloudron performs WAL-aware, consistent backups instead of a raw filesystem copy.

### 4.2 `Dockerfile.cloudron`

Because the repo already has a `Dockerfile`, Cloudron conventions say to name the Cloudron-specific one `Dockerfile.cloudron` (or place it in `cloudron/Dockerfile`).

```dockerfile
# syntax=docker/dockerfile:1
FROM cloudron/base:5.0.0@sha256:04fd70dbd8ad6149c19de39e35718e024417c3e01dc9c6637eaf4a41ec4e596c

# ---------------------------------------------------------------
# 1. Install Bun runtime
# cloudron/base is Ubuntu-based; Bun publishes a generic installer
# ---------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates unzip \
    && curl -fsSL https://bun.sh/install | bash \
    && mv /root/.bun/bin/bun /usr/local/bin/bun \
    && apt-get purge -y curl unzip && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------
# 2. Install global npm/bun packages (routstrd)
# ---------------------------------------------------------------
RUN bun install --global routstrd \
    && ln -s /root/.bun/bin/routstrd /usr/local/bin/routstrd

# ---------------------------------------------------------------
# 3. Prepare /app/code (Cloudron convention for application code)
# ---------------------------------------------------------------
RUN mkdir -p /app/code
WORKDIR /app/code

# Copy the auth proxy source
ADD package.json bun.lockb ./
ADD src ./src
ADD dist ./dist

# Install auth proxy deps
RUN bun install --production

# ---------------------------------------------------------------
# 4. Supervisor setup for multi-process container
# ---------------------------------------------------------------
RUN mkdir -p /app/code/supervisor
ADD cloudron/supervisor/routstrd.conf /etc/supervisor/conf.d/routstrd.conf
ADD cloudron/supervisor/auth.conf    /etc/supervisor/conf.d/auth.conf
RUN ln -sf /run/supervisord.log /var/log/supervisor/supervisord.log

# ---------------------------------------------------------------
# 5. Runtime startup script
# ---------------------------------------------------------------
ADD cloudron/start.sh /app/code/start.sh
RUN chmod +x /app/code/start.sh

CMD [ "/app/code/start.sh" ]
```

**Important Cloudron Dockerfile rules:**
- Do **not** create or populate `/app/data` in the Dockerfile. It is mounted empty at runtime by the platform.
- Do **not** bake secrets or dynamic configs into the image.
- Use `/app/code` for immutable application code.
- `EXPOSE` is optional but good practice.

### 4.3 `cloudron/start.sh`

The entrypoint script runs as **root**. It must:
1. Initialize `/app/data` on first run.
2. Fix ownership so the `cloudron` user can write.
3. Start `supervisord` (which stays in the foreground).

```bash
#!/bin/bash
set -eu

# ------------------------------------------------------------------
# 1. Data directory init
# ------------------------------------------------------------------
echo "==> Ensuring /app/data ownership..."
mkdir -p /app/data
chown -R cloudron:cloudron /app/data

# ------------------------------------------------------------------
# 2. One-time first-install setup
# ------------------------------------------------------------------
if [[ ! -f /app/data/.initialized ]]; then
    echo "==> First run detected. Setting up data directory..."
    # routstrd expects ROUTSTRD_DIR; we point it at /app/data/routstrd
    # Any bootstrap DB copy or config generation goes here
    touch /app/data/.initialized
    echo "==> Initialization complete."
fi

# ------------------------------------------------------------------
# 3. Launch supervisor (runs routstrd + routstrd-auth as children)
# ------------------------------------------------------------------
echo "==> Starting supervisord..."
exec /usr/bin/supervisord --configuration /etc/supervisor/supervisord.conf --nodaemon -i RoutstrdApp
```

**Why `exec`?** Bash does not forward SIGTERM to children by default. `exec` replaces the shell process so signals reach `supervisord` directly, allowing clean shutdowns.

### 4.4 Supervisor configs

#### `cloudron/supervisor/routstrd.conf`

```ini
[program:routstrd]
priority=10
directory=/app/data
environment=HOME=/app/data,ROUTSTRD_DIR=/app/data/routstrd
command=/usr/local/bin/routstrd --port 8009 --db-path /app/data/routstr.db
user=cloudron
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
```

#### `cloudron/supervisor/auth.conf`

```ini
[program:auth]
priority=20
directory=/app/code
environment=HOME=/app/data,ROUTSTRD_DIR=/app/data/routstrd,ROUTSTRD_UPSTREAM=http://localhost:8009,ROUTSTRD_DB_PATH=/app/data/routstrd/routstr.db,ROUTSTRD_AUTH_PORT=8008,ROUTSTRD_AUTH_HOST=0.0.0.0
command=/usr/local/bin/bun run /app/code/src/index.ts start
user=cloudron
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
```

**Priority logic:** `routstrd` (priority 10) starts before `auth` (priority 20) so the upstream is ready when the proxy tries to connect. Supervisor still starts them quickly; if `auth` crashes on first connect, `autorestart=true` will retry.

---

## 5. Environment Variable Mapping

Cloudron injects several useful environment variables at runtime. The ones most relevant to this app:

| Cloudron Variable | Usage |
|-------------------|-------|
| `CLOUDRON` | Set to `1`. Useful for detecting Cloudron mode and altering defaults. |
| `CLOUDRON_APP_DOMAIN` | The public domain (e.g., `routstr.example.com`). Can be used in generated links or OpenAPI `servers` blocks. |
| `CLOUDRON_APP_ORIGIN` | Full origin `https://routstr.example.com`. |
| `CLOUDRON_PROXY_IP` | IP of Cloudron’s internal nginx. Use this to trust `X-Forwarded-For` / `X-Forwarded-Proto`. |

**Recommended code change:** In `src/config.ts` (or wherever env vars are loaded), detect `CLOUDRON=1` and default:
- `ROUTSTRD_DIR` → `/app/data/routstrd`
- `ROUTSTRD_DB_PATH` → `/app/data/routstrd/routstr.db`
- `ROUTSTRD_UPSTREAM` → `http://localhost:8009`
- `ROUTSTRD_AUTH_PORT` → `8008`
- `ROUTSTRD_AUTH_HOST` → `0.0.0.0`

This makes the Cloudron package work out of the box without requiring the user to set custom env vars.

---

## 6. Filesystem & Data Persistence

### Where things go

| Purpose | Path | Notes |
|---------|------|-------|
| Auth proxy code | `/app/code` | Read-only, updated on app update. |
| SQLite DB | `/app/data/routstr.db` | Persistent, WAL-aware backup via `localstorage.sqlite` addon. |
| routstrd config / logs / pid | `/app/data` | `ROUTSTRD_DIR=/app/data/routstrd` ensures everything lands here. |
| Temp files | `/tmp` | Ephemeral; cleaned periodically by Cloudron. |
| Runtime state | `/run` | Ephemeral; survives restarts but not updates/rebuilds. |

### SQLite backup safety

Because SQLite uses WAL mode, a naive filesystem copy can be inconsistent. By declaring:

```json
"localstorage": {
  "sqlite": {
    "paths": ["/app/data/routstr.db"]
  }
}
```

…Cloudron pauses writes and takes a consistent snapshot during backup. This is **strongly recommended** over just using plain `localstorage`.

---

## 7. Multi-Process & No Docker Compose

Cloudron **does not support `docker-compose`** (confirmed in docs and forums). The official recommendation for apps with more than one component is to use **supervisord**, **pm2**, or a similar process manager inside a single container.

For `routstrd-auth`, the two components are:
1. **routstrd** — the backend daemon (localhost only, port 8009).
2. **routstrd-auth** — the public auth proxy (port 8008).

Supervisor is the battle-tested choice on Cloudron because it:
- Restarts crashed children.
- Forwards logs to stdout/stderr.
- Respects startup priorities.
- Is already available in `cloudron/base`.

---

## 8. Build, Install & Update Workflow

### Prerequisites (on your workstation)

```bash
npm install -g cloudron
cloudron login my.example.com
```

### Development loop

```bash
# 1. Build & install (first time)
cd routstrd-auth
cloudron install --image   # if using local Docker build, or:
cloudron install             # if building directly on the Cloudron server

# 2. Iterate
# ... edit code ...
cloudron update

# 3. Inspect logs
cloudron logs -f

# 4. Shell into running container
cloudron exec

# 5. Debug a crashing app (read-write fs, app paused)
cloudron debug
cloudron debug --disable
```

### Alternative: local Docker build + registry

```bash
docker login
cloudron build
# pushes image to registry
cd ..
cloudron install --image registry.io/username/routstrd-auth:tag
```

---

## 9. Auth & Security on Cloudron

### Option A: Keep app-native Bearer auth (recommended)

`routstrd-auth` already validates `Authorization: Bearer sk-...` tokens against the shared SQLite DB. This is self-contained and does not need Cloudron’s user database.

In this case, **do not** add the `proxyAuth` or `ldap` addons. The app handles its own identity layer.

### Option B: Add Cloudron SSO (optional future enhancement)

If you ever want to replace Bearer tokens with Cloudron’s centralized user management:

1. Add `"oidc": {}` or `"ldap": {}` to the manifest `addons`.
2. Read `CLOUDRON_OIDC_*` or `CLOUDRON_LDAP_*` env vars in `start.sh`.
3. Configure `routstrd-auth` to accept Cloudron session cookies or Basic Auth.
4. Set `optionalSso: true` if the app should support both SSO and non-SSO installs.

**Note:** Due to a platform limitation, auth addons cannot be added to an already-installed app. Users must reinstall to enable SSO.

---

## 10. Health Checks

Cloudron polls `healthCheckPath` continuously. The existing `routstrd-auth` proxy already exposes `GET /health`, which returns a 2xx when the proxy is up. That is sufficient.

If you want a stricter health check, ensure `/health` also verifies that the upstream `routstrd` daemon is reachable on `localhost:8009` before returning 200. If either component is dead, Cloudron will restart the whole container.

---

## 11. Gotchas & Checklist

- [ ] **Do not** use the existing `Dockerfile` verbatim — it uses `oven/bun` base and assumes `/data`. Cloudron requires `cloudron/base` and `/app/data`.
- [ ] **Do not** write to `/data`, `/root`, or `/home` at runtime. Use `/app/data`.
- [ ] **Do not** cache env vars across restarts. Read them fresh each time `start.sh` or the app starts.
- [ ] **Do** use `exec` in `start.sh` so signals propagate.
- [ ] **Do** run app processes as `cloudron` user, not root.
- [ ] **Do** declare `memoryLimit` generously (e.g., 512 MB) because two Bun processes run together.
- [ ] **Do** test `cloudron update` after `cloudron install`; updates are the primary lifecycle event.
- [ ] **Do** add `.dockerignore` entries for `node_modules`, `.git`, `dist` (if rebuilt in image), and local dev files so `cloudron install` uploads stay small.

---

## 12. Summary of Changes Needed in This Repo

| File | Action |
|------|--------|
| `CloudronManifest.json` | **Create** — metadata, port 8008, `localstorage` addon with SQLite path. |
| `Dockerfile.cloudron` | **Create** — based on `cloudron/base:5.0.0`, installs Bun, installs `routstrd`, copies app code, adds supervisor configs. |
| `cloudron/start.sh` | **Create** — init `/app/data`, chown, exec supervisord. |
| `cloudron/supervisor/routstrd.conf` | **Create** — supervisord program for daemon on port 8009. |
| `cloudron/supervisor/auth.conf` | **Create** — supervisord program for auth proxy on port 8008. |
| `src/config.ts` | **Modify** — detect `CLOUDRON=1` and default paths/ports to Cloudron conventions. |
| `.dockerignore` | **Modify** — exclude `cloudron/`, `Dockerfile.cloudron`, local build artifacts. |
| `docker-compose.yml` | **Ignore / remove** — not used by Cloudron. Can be kept for local dev but document that it is not used in production on Cloudron. |

---

## 13. References

- [Cloudron Packaging Docs](https://docs.cloudron.io/packaging/)
- [Manifest Reference](https://docs.cloudron.io/packaging/manifest/)
- [Addons Reference](https://docs.cloudron.io/packaging/addons/)
- [Cheat Sheet](https://docs.cloudron.io/packaging/cheat-sheet/)
- [Tutorial — Node.js App](https://git.cloudron.io/docs/tutorial-nodejs-app)
- [Tutorial — Multi-process (Supervisor) App](https://git.cloudron.io/docs/tutorial-supervisor-app)
- [Cloudron Forum — Packaging Help](https://forum.cloudron.io/category/96/app-packaging-development)
