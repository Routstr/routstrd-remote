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

# First run: initialize the Cashu wallet. routstrd does not create the wallet
# directory/config on its own, so on a fresh data directory the daemon
# crash-loops with "ENOENT .../wallet/wallet.pid". The cocod-based init that
# used to do this was removed in 6a8d625 without a replacement. Run it as the
# cloudron user so the generated wallet files are not root-owned.
if [[ ! -f "${ROUTSTRD_DIR}/wallet/config.json" ]]; then
    echo "==> First run detected. Initializing Cashu wallet..."
    gosu cloudron:cloudron env HOME="${HOME}" ROUTSTRD_DIR="${ROUTSTRD_DIR}" \
        routstrd onboard --skip-integration </dev/null
    # onboard starts a daemon; stop it so supervisord remains the sole owner of
    # the routstrd process (and its PID file). Let a failed stop abort startup:
    # otherwise supervisord could start while the old daemon still holds the
    # wallet PID lock.
    gosu cloudron:cloudron env HOME="${HOME}" ROUTSTRD_DIR="${ROUTSTRD_DIR}" \
        routstrd stop </dev/null
fi

if [[ ! -f /app/data/.initialized ]]; then
    echo "==> First run detected. Initializing data files..."
    touch /app/data/.initialized
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

# The bun step above runs as root and Bun.write() creates ${ROUTSTRD_DIR} (and
# $HOME/.bun) as root, but the daemon runs as cloudron and must be able to
# create logs/, wallet/, etc. inside it. Reclaim ownership of the whole data
# directory, not just config.json.
chown -R cloudron:cloudron /app/data

echo "==> Starting supervisord..."
exec /usr/bin/supervisord --configuration /etc/supervisor/supervisord-cloudron.conf -i RoutstrdApp
