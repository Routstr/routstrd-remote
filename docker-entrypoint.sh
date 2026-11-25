#!/bin/sh
set -e
umask 077

# Ensure data directories exist for routstrd
export ROUTSTRD_DIR="${ROUTSTRD_DIR:-/data/routstrd}"
mkdir -p "$ROUTSTRD_DIR" /data/logs
# Repair existing credentials before rewriting config or starting the daemon.
chmod -R go-rwx -- "$ROUTSTRD_DIR"

# routstrd stays local to the container. routstrd-auth is the public service.
ROUTSTRD_PORT="${ROUTSTRD_PORT:-${PORT:-8008}}"
ROUTSTRD_AUTH_PORT="${ROUTSTRD_AUTH_PORT:-8080}"
ROUTSTRD_AUTH_HOST="${ROUTSTRD_AUTH_HOST:-0.0.0.0}"
ROUTSTRD_UPSTREAM="${ROUTSTRD_UPSTREAM:-http://localhost:${ROUTSTRD_PORT}}"
# The container's own Nostr identity is seeded as the first admin below, so the
# npubs table is never empty and the anonymous first-admin claim path is never
# reachable. ROUTSTRD_AUTH_ADMIN_NPUBS still adds extra admins when set.
ROUTSTRD_AUTH_ADMIN_NPUBS="${ROUTSTRD_AUTH_ADMIN_NPUBS:-}"
ROUTSTRD_AUTH_BOOTSTRAP_TOKEN="${ROUTSTRD_AUTH_BOOTSTRAP_TOKEN:-}"
export ROUTSTRD_AUTH_PORT ROUTSTRD_AUTH_HOST ROUTSTRD_UPSTREAM
export ROUTSTRD_AUTH_ADMIN_NPUBS ROUTSTRD_AUTH_BOOTSTRAP_TOKEN

# Ensure routstrd's config.json has authUrl pointing to the auth proxy and a Nostr identity.
ROUTSTRD_CONFIG="${ROUTSTRD_DIR}/config.json"
AUTH_URL="http://localhost:${ROUTSTRD_AUTH_PORT}"
echo "Configuring authUrl (${AUTH_URL}) and Nostr identity in ${ROUTSTRD_CONFIG}..."
bun -e '
  let nostrTools;
  try {
    nostrTools = await import("nostr-tools");
  } catch {
    try {
      nostrTools = await import("/app/code/node_modules/nostr-tools");
    } catch {
      nostrTools = await import("/usr/local/bun/install/global/node_modules/routstrd/node_modules/nostr-tools");
    }
  }
  const { generateSecretKey, nip19, getPublicKey } = nostrTools;
  const configPath = process.argv[1];
  const authUrl = process.argv[2];

  let config = {};
  try {
    if (await Bun.file(configPath).exists()) {
      config = JSON.parse(await Bun.file(configPath).text());
    }
  } catch {}

  config.authUrl = authUrl;

  if (!config.nsec) {
    const sk = generateSecretKey();
    config.nsec = nip19.nsecEncode(sk);
    const npub = nip19.npubEncode(getPublicKey(sk));
    console.log(`Generated container Nostr identity: ${npub}`);
  }

  await Bun.write(configPath, JSON.stringify(config, null, 2) + "\n");

  // Hand the npub of this identity to the shell so it can be seeded as admin.
  try {
    const decoded = nip19.decode(config.nsec);
    await Bun.write("/tmp/routstrd-container-npub", nip19.npubEncode(getPublicKey(decoded.data)) + "\n");
  } catch (error) {
    console.warn(`Warning: could not derive an npub from ${configPath}: ${error}`);
  }
' "${ROUTSTRD_CONFIG}" "${AUTH_URL}"

# Seed the container's own identity as admin (see cloudron/start.sh for the
# rationale): the bundled CLI signs with this nsec, so `routstrd npubs add`
# works from a shell in the container with nothing to copy.
CONTAINER_NPUB=""
if [ -s /tmp/routstrd-container-npub ]; then
    CONTAINER_NPUB=$(tr -d '\n' < /tmp/routstrd-container-npub)
    rm -f /tmp/routstrd-container-npub
fi

if [ -n "$CONTAINER_NPUB" ]; then
    case ",${ROUTSTRD_AUTH_ADMIN_NPUBS}," in
        *",${CONTAINER_NPUB},"*) ;;
        *)
            if [ -n "$ROUTSTRD_AUTH_ADMIN_NPUBS" ]; then
                ROUTSTRD_AUTH_ADMIN_NPUBS="${CONTAINER_NPUB},${ROUTSTRD_AUTH_ADMIN_NPUBS}"
            else
                ROUTSTRD_AUTH_ADMIN_NPUBS="${CONTAINER_NPUB}"
            fi
            ;;
    esac
    export ROUTSTRD_AUTH_ADMIN_NPUBS
    echo "The container's Nostr identity is an admin: ${CONTAINER_NPUB}"
fi

_term() {
  echo "Shutting down..."
  if [ -n "${AUTH_PID:-}" ]; then
    kill "$AUTH_PID" 2>/dev/null || true
  fi
  routstrd stop 2>/dev/null || true
  wait 2>/dev/null || true
}
trap _term INT TERM

# Start the routstrd daemon first. The CLI daemonizes and exits after starting
# the real daemon, so do not monitor this shell child as the service lifetime.
echo "Starting routstrd daemon on localhost:${ROUTSTRD_PORT}..."
routstrd start --port "$ROUTSTRD_PORT"

# Start routstrd-auth as the public-facing service.
echo "Starting routstrd-auth on ${ROUTSTRD_AUTH_HOST}:${ROUTSTRD_AUTH_PORT}..."
echo "routstrd-auth upstream: ${ROUTSTRD_UPSTREAM}"
bun run /app/src/index.ts start &
AUTH_PID=$!

# Keep PID 1 alive while routstrd-auth is running. Also periodically verify
# that the internal routstrd daemon remains reachable.
while :; do
  if ! kill -0 "$AUTH_PID" 2>/dev/null; then
    echo "routstrd-auth exited."
    wait "$AUTH_PID"
    exit $?
  fi

  if ! bun -e "const r=await fetch('http://localhost:${ROUTSTRD_PORT}/health');process.exit(r.ok?0:1)" >/dev/null 2>&1; then
    echo "routstrd daemon health check failed."
    kill "$AUTH_PID" 2>/dev/null || true
    exit 1
  fi

  sleep 5
done
