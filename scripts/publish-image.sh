#!/usr/bin/env bash
#
# scripts/publish-image.sh — build, gate, then push the Cloudron image.
#
# The order is the point: the Trivy gate (scripts/security-scan.sh) runs on the
# exact image that would be published, and a failing gate aborts before
# `podman push`, so a vulnerable image never becomes pullable and can never be
# registered in CloudronVersions.json. Also prints the bundled routstrd /
# routstr-sdk versions so the CHANGELOG line can be checked against reality.
#
#   ./scripts/publish-image.sh                  # build + gate + push, fresh tag
#   ./scripts/publish-image.sh --no-push        # build + gate only
#   ./scripts/publish-image.sh --tag my-tag     # reuse a tag
#   ./scripts/publish-image.sh --gate new       # only fail on non-base CVEs
#   ./scripts/publish-image.sh --no-build --tag <tag>   # gate+push existing
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

IMAGE_REPO="${IMAGE_REPO:-ghcr.io/sh1ftred/routstrd-pro}"
TAG=""
DO_BUILD=1
DO_PUSH=1
GATE_ARGS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --tag) TAG="${2:?--tag needs a value}"; shift 2 ;;
        --no-build) DO_BUILD=0; shift ;;
        --no-push) DO_PUSH=0; shift ;;
        --gate|--ignore-unfixed|--secrets|--no-deps|--base)
            GATE_ARGS+=("$1")
            case "$1" in --gate|--base) GATE_ARGS+=("${2:?$1 needs a value}"); shift ;; esac
            shift ;;
        -h|--help) sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown flag: $1" >&2; exit 2 ;;
    esac
done

[[ -n "$TAG" ]] || TAG="$(date -u +%Y%m%d-%H%M%S)-$(git rev-parse --short=9 HEAD)"
IMAGE="$IMAGE_REPO:$TAG"

if [[ "$DO_BUILD" == "1" ]]; then
    echo "==> Building $IMAGE"
    podman build -t "$IMAGE" . 2>&1 | tee /tmp/routstrd-auth-build.log
else
    podman image exists "$IMAGE" || { echo "error: $IMAGE is not in local storage" >&2; exit 2; }
fi

echo
echo "==> Bundled versions in $IMAGE (verify against the CHANGELOG entry)"
podman run --rm --entrypoint /usr/local/bin/routstrd "$IMAGE" --version || true
podman run --rm --entrypoint /bin/sh "$IMAGE" -c \
    'grep -m1 "\"version\"" /usr/local/bun/install/global/node_modules/@routstr/sdk/package.json' || true

echo
echo "==> Security gate"
"$REPO_ROOT/scripts/security-scan.sh" "$IMAGE" "${GATE_ARGS[@]}"

if [[ "$DO_PUSH" == "1" ]]; then
    echo
    echo "==> Pushing $IMAGE"
    podman push "$IMAGE"
    echo
    echo "Pushed: $IMAGE"
    echo "Next: cloudron versions add --image \"$IMAGE\"   (see AGENTS.md step 7)"
else
    echo
    echo "Gate passed for $IMAGE — not pushed (--no-push)."
fi
