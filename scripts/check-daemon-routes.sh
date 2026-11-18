#!/usr/bin/env bash
# Inspect the installed release artifacts, without starting either service.
set -euo pipefail
cd "$(dirname "$0")/.."
image=${1:?usage: check-daemon-routes.sh IMAGE}
inventory=$(cat scripts/reviewed/daemon-routes.json)
sources=$(sha256sum src/proxy.ts src/daemon-routes.ts)
exec podman run --rm --pull never --network none -i --entrypoint /usr/local/bin/bun "$image" - \
    /usr/local/bun/install/global/node_modules/routstrd /app/code/src \
    "$inventory" "$sources" < scripts/lib/check-daemon-routes.ts
