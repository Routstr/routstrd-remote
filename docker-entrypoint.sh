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
CONTAINER_NPUB=$(bun -e '
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

  if (!config.nsec) config.nsec = nip19.nsecEncode(generateSecretKey());
  let npub;
  try {
      const decoded = /^[a-f0-9]{64}$/i.test(config.nsec)
          ? { type: "nsec", data: Uint8Array.from(Buffer.from(config.nsec, "hex")) }
          : nip19.decode(config.nsec);
      if (decoded.type !== "nsec") throw new Error("Invalid key type");
      npub = nip19.npubEncode(getPublicKey(decoded.data));
  } catch {
      console.error("Cannot seed admin: invalid routstrd private key in config.json.");
      process.exit(1);
  }
  await Bun.write(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log(npub);
' "${ROUTSTRD_CONFIG}" "${AUTH_URL}")

# Apply the container identity alongside any operator-configured admins.
ROUTSTRD_AUTH_ADMIN_NPUBS="${CONTAINER_NPUB}${ROUTSTRD_AUTH_ADMIN_NPUBS:+,${ROUTSTRD_AUTH_ADMIN_NPUBS}}"
export ROUTSTRD_AUTH_ADMIN_NPUBS
echo "The container's Nostr identity is an admin: ${CONTAINER_NPUB}"

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
