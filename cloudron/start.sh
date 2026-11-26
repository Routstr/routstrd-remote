#!/bin/bash
set -eu
# Onboarding and the supervised services must create secrets owner-only.
umask 077

echo "==> Preparing persistent data directory..."
mkdir -p /app/data/logs
chown -R cloudron:cloudron /app/data

# Use the same persistent paths as the packaged Supervisor programs.
export HOME="/app/data"
export ROUTSTRD_DIR="/app/data/routstrd"
export ROUTSTRD_AUTH_HOST="${ROUTSTRD_AUTH_HOST:-0.0.0.0}"
export ROUTSTRD_AUTH_PORT="${ROUTSTRD_AUTH_PORT:-8008}"
export ROUTSTRD_PORT="${ROUTSTRD_PORT:-8009}"
export ROUTSTRD_UPSTREAM="${ROUTSTRD_UPSTREAM:-http://localhost:${ROUTSTRD_PORT}}"
export ROUTSTRD_DB_PATH="${ROUTSTRD_DIR}/routstr.db"

# Repair older volumes before any secrets are read or rewritten. A failed
# repair must stop startup rather than silently leave old credentials exposed.
if [[ -d "${ROUTSTRD_DIR}" ]]; then
    gosu cloudron:cloudron chmod -R go-rwx -- "${ROUTSTRD_DIR}"
fi

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
# Match the origin the proxy requires for NIP-98 signatures.
AUTH_URL="${ROUTSTRD_AUTH_PUBLIC_URL:-${CLOUDRON_APP_ORIGIN:-http://localhost:${ROUTSTRD_AUTH_PORT}}}"
echo "==> Configuring authUrl (${AUTH_URL}) and Nostr identity in ${ROUTSTRD_CONFIG}..."
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
echo "==> Container Nostr identity is an admin: ${CONTAINER_NPUB}"
echo "    Add a person with: routstrd npubs add <their npub> --role admin --name \"Their Name\""

# The bun step above runs as root and Bun.write() creates ${ROUTSTRD_DIR} (and
# $HOME/.bun) as root, but the daemon runs as cloudron and must be able to
# create logs/, wallet/, etc. inside it. Reclaim ownership of the whole data
# directory, not just config.json.
chown -R cloudron:cloudron /app/data

echo "==> Starting supervisord..."
exec /usr/bin/supervisord --configuration /etc/supervisor/supervisord-cloudron.conf -i RoutstrdApp
