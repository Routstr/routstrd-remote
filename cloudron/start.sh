#!/bin/bash
set -eu

echo "==> Preparing persistent data directory..."
mkdir -p /app/data/logs
chown -R cloudron:cloudron /app/data

# Make Cloudron defaults visible to every child process. Users can still
# override these through Cloudron environment variables if needed.
export HOME="/app/data"
export ROUTSTRD_DIR="${ROUTSTRD_DIR:-/app/data/routstrd}"
export ROUTSTRD_AUTH_HOST="${ROUTSTRD_AUTH_HOST:-0.0.0.0}"
export ROUTSTRD_AUTH_PORT="${ROUTSTRD_AUTH_PORT:-8008}"
export ROUTSTRD_PORT="${ROUTSTRD_PORT:-8009}"
export ROUTSTRD_UPSTREAM="${ROUTSTRD_UPSTREAM:-http://localhost:${ROUTSTRD_PORT}}"
export ROUTSTRD_DB_PATH="${ROUTSTRD_DB_PATH:-/app/data/routstrd/routstr.db}"

if [[ ! -f /app/data/.initialized ]]; then
    echo "==> First run detected. Initializing data files..."
    touch /app/data/.initialized
    chown -R cloudron:cloudron /app/data
    echo "==> Initialization complete."
fi

# Ensure routstrd's config.json has authUrl pointing to the auth proxy and a Nostr identity.
ROUTSTRD_CONFIG="${ROUTSTRD_DIR}/config.json"
AUTH_URL="http://localhost:${ROUTSTRD_AUTH_PORT}"
echo "==> Configuring authUrl (${AUTH_URL}) and Nostr identity in ${ROUTSTRD_CONFIG}..."
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
        console.log(`==> Generated container Nostr identity: ${npub}`);
    }

    await Bun.write(configPath, JSON.stringify(config, null, 2) + "\n");
' "${ROUTSTRD_CONFIG}" "${AUTH_URL}"
chown cloudron:cloudron "${ROUTSTRD_CONFIG}" 2>/dev/null || true
echo "==> Starting supervisord..."
exec /usr/bin/supervisord --configuration /etc/supervisor/supervisord-cloudron.conf -i RoutstrdApp
