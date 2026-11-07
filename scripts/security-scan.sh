#!/usr/bin/env bash
#
# scripts/security-scan.sh — blocking vulnerability gate for the release flow.
#
# Scans the image that is about to be pushed to GHCR with Trivy and exits
# non-zero if it finds a CRITICAL vulnerability that is not explicitly accepted
# in .trivyignore.yaml. Run it between `podman build` and `podman push`
# (AGENTS.md, release Step 5b) so a vulnerable image can never reach the
# CloudronVersions.json catalog.
#
#   ./scripts/security-scan.sh ghcr.io/sh1ftred/routstrd-pro:20261023-164755-b5e186d77
#   ./scripts/security-scan.sh <tag> --gate new      # ignore inherited base CVEs
#   ./scripts/security-scan.sh <tag> --ignore-unfixed
#
# Trivy runs from its own container, so nothing is baked into the release image
# and no database state lives on the host beyond ~/.cache/trivy.
#
# Exit codes: 0 = gate passed, 1 = gate failed (findings), 2 = infrastructure
# problem (trivy could not run, no report produced). A missing report is never
# treated as a pass.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

usage() { sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

IMAGE=""
GATE_MODE="${GATE:-strict}"
IGNORE_UNFIXED="${IGNORE_UNFIXED:-0}"
SCAN_SECRETS="${SCAN_SECRETS:-0}"
SCAN_DEPS="${SCAN_DEPS:-1}"
EXTRA_SEVERITIES="${EXTRA_SEVERITIES:-}"
REPORTS_DIR="${REPORTS_DIR:-reports}"
IGNORE_FILE="${IGNORE_FILE:-.trivyignore.yaml}"
CACHE_DIR="${TRIVY_CACHE_DIR:-$HOME/.cache/trivy}"
SCAN_MODE="${SCAN_MODE:-auto}"
# Pinned so a release is scanned by a known Trivy build; bump deliberately.
TRIVY_IMAGE="${TRIVY_IMAGE:-docker.io/aquasec/trivy:0.76.1}"
BASE_IMAGE="${BASE_IMAGE:-}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --gate) GATE_MODE="${2:?--gate needs strict|new|none}"; shift 2 ;;
        --ignore-unfixed) IGNORE_UNFIXED=1; shift ;;
        --secrets) SCAN_SECRETS=1; shift ;;
        --no-deps) SCAN_DEPS=0; shift ;;
        --base) BASE_IMAGE="${2:?--base needs an image ref}"; shift 2 ;;
        -h|--help) usage 0 ;;
        -*) echo "unknown flag: $1" >&2; usage 2 ;;
        *) IMAGE="$1"; shift ;;
    esac
done

[[ -n "$IMAGE" ]] || { echo "error: no image reference given" >&2; usage 2; }
command -v jq >/dev/null || { echo "error: jq is required" >&2; exit 2; }

mkdir -p "$CACHE_DIR" "$REPORTS_DIR"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
SLUG="$(printf '%s' "$IMAGE" | tr '/:@' '___')"
OUT_PREFIX="$REPORTS_DIR/trivy-$SLUG"
SEVERITIES="CRITICAL${EXTRA_SEVERITIES:+,$EXTRA_SEVERITIES}"

# ---------------------------------------------------------------- container runtime

RUNNER=""
SECOPT=()
if command -v podman >/dev/null; then
    RUNNER=podman
    # Rootless podman on an SELinux host needs labelling off for bind mounts.
    SECOPT=(--security-opt label=disable)
elif command -v docker >/dev/null; then
    RUNNER=docker
else
    echo "error: neither podman nor docker is available" >&2
    exit 2
fi

SOCK_VOL=()
if [[ "$SCAN_MODE" == "auto" || "$SCAN_MODE" == "socket" ]]; then
    SOCK=""
    if [[ "$RUNNER" == "podman" ]]; then
        SOCK="$(podman info --format '{{.Host.RemoteSocket.Path}}' 2>/dev/null || true)"
        [[ -n "$SOCK" && -S "$SOCK" ]] || SOCK=""
    else
        SOCK="/var/run/docker.sock"
        [[ -S "$SOCK" ]] || SOCK=""
    fi
    if [[ -n "$SOCK" ]]; then
        SOCK_VOL=(-e DOCKER_HOST=unix:///var/run/docker.sock
                  -v "$SOCK:/var/run/docker.sock")
    elif [[ "$SCAN_MODE" == "socket" ]]; then
        echo "error: no container runtime socket found (tried $RUNNER)" >&2
        exit 2
    fi
fi

if [[ ${#SOCK_VOL[@]} -eq 0 ]]; then
    # No API socket: export the image to a tar and let Trivy read it directly.
    echo "==> No runtime socket; exporting image to a tarball for scanning"
    TAR_PATH="$REPO_ROOT/$OUT_PREFIX.tar"
    rm -f "$TAR_PATH"
    "$RUNNER" save -o "$TAR_PATH" "$IMAGE" || { echo "error: $RUNNER save failed" >&2; exit 2; }
fi

IGNORE_ARGS=()
if [[ -f "$IGNORE_FILE" ]]; then
    IGNORE_ARGS=(--ignorefile "/scan/$IGNORE_FILE")
fi

# trivy <trivy-args...> — always runs Trivy from its own container with the
# vulnerability DB cached on the host and the repo mounted read-only at /scan.
trivy() {
    local scan_args=(--quiet --severity "$SEVERITIES")
    [[ "$IGNORE_UNFIXED" == "1" ]] && scan_args+=(--ignore-unfixed)
    [[ "$SCAN_SECRETS" == "1" ]] && scan_args+=(--scanners "vuln,secret")

    "$RUNNER" run --rm \
        "${SECOPT[@]}" \
        "${SOCK_VOL[@]}" \
        -v "$CACHE_DIR:/root/.cache/trivy" \
        -v "$REPO_ROOT:/scan:ro" \
        -v "$REPO_ROOT/$REPORTS_DIR:/scan/$REPORTS_DIR" \
        -w /scan \
        "$TRIVY_IMAGE" "$@" "${scan_args[@]}" "${IGNORE_ARGS[@]}"
}

# ---------------------------------------------------------------- scan

scan_image() {  # scan_image <image-or---input=PATH> <out.json> ; exit code preserved
    local target="$1" out="$2"
    local args=(image --format json -o "/scan/${out#"$REPO_ROOT"/}")
    if [[ "$target" == --input=* ]]; then
        trivy "${args[@]}" --input "${target#--input=}"
    else
        trivy "${args[@]}" "$target"
    fi
}

rc=0
if [[ ${#SOCK_VOL[@]} -eq 0 ]]; then
    scan_image "--input=/scan/$OUT_PREFIX.tar" "$OUT_PREFIX.json" || rc=$?
else
    scan_image "$IMAGE" "$OUT_PREFIX.json" || rc=$?
fi

if [[ ! -s "$OUT_PREFIX.json" ]] || ! jq -e . "$OUT_PREFIX.json" >/dev/null 2>&1; then
    echo "error: Trivy produced no usable report (exit $rc) — treating as gate failure to run" >&2
    exit 2
fi
[[ "$rc" -ne 0 && "$rc" -ne 1 ]] && { echo "error: trivy exited $rc" >&2; exit 2; }

# ---------------------------------------------------------------- base-image diff

BASE_JSON=""
if [[ -z "$BASE_IMAGE" && -f Dockerfile ]]; then
    BASE_IMAGE="$(awk 'toupper($1)=="FROM"{print $2; exit}' Dockerfile | sed 's/^--platform=[^ ]* //')"
fi
if [[ -n "$BASE_IMAGE" ]]; then
    BASE_JSON="$OUT_PREFIX.base.json"
    echo "==> Scanning base image for attribution: $BASE_IMAGE"
    if [[ ${#SOCK_VOL[@]} -eq 0 ]]; then
        "$RUNNER" save -o "$OUT_PREFIX.base.tar" "$BASE_IMAGE" >/dev/null 2>&1 || true
        scan_image "--input=/scan/$OUT_PREFIX.base.tar" "$BASE_JSON" >/dev/null 2>&1 || true
        rm -f "$OUT_PREFIX.base.tar"
    else
        scan_image "$BASE_IMAGE" "$BASE_JSON" >/dev/null 2>&1 || true
    fi
    jq -e . "$BASE_JSON" >/dev/null 2>&1 || BASE_JSON=""
fi

# ---------------------------------------------------------------- dependency scan

DEPS_JSON=""
if [[ "$SCAN_DEPS" == "1" ]]; then
    DEPS_JSON="$OUT_PREFIX.deps.json"
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    cp package.json "$tmp"/
    if [[ -f bun.lock ]]; then
        cp bun.lock "$tmp"/
    elif [[ -f bun.lockb ]] && command -v bun >/dev/null; then
        # Trivy only understands the text lockfile; convert a throwaway copy.
        cp bun.lockb "$tmp"/
        ( cd "$tmp" && bun install --lockfile-only --save-text-lockfile >/dev/null 2>&1 ) \
            || { echo "error: could not convert bun.lockb to bun.lock for scanning" >&2; exit 2; }
        rm -f "$tmp/bun.lockb"
    else
        echo "warn: no bun lockfile found; dependency scan skipped" >&2
        DEPS_JSON=""
    fi
    if [[ -n "$DEPS_JSON" ]]; then
        echo "==> Scanning dependency lockfile (bun)"
        "$RUNNER" run --rm \
            "${SECOPT[@]}" \
            -v "$CACHE_DIR:/root/.cache/trivy" \
            -v "$REPO_ROOT:/scan:ro" \
            -v "$REPO_ROOT/$REPORTS_DIR:/scan/$REPORTS_DIR" \
            -v "$tmp:/deps:ro" \
            -w /scan \
            "$TRIVY_IMAGE" fs --scanners vuln --format json \
            --severity "$SEVERITIES" "${IGNORE_ARGS[@]}" \
            -o "/scan/${DEPS_JSON#"$REPO_ROOT"/}" /deps >/dev/null 2>&1 || true
        [[ -s "$DEPS_JSON" ]] || DEPS_JSON=""
    fi
fi

# ---------------------------------------------------------------- report

findings() { jq -r '[.Results[]?|.Vulnerabilities[]?]|length' "$1" 2>/dev/null || echo 0; }

NEW_JSON="$OUT_PREFIX.new.json"
if [[ -n "$BASE_JSON" ]]; then
    # A finding is "inherited" when the base image has a CRITICAL with the same
    # CVE in the same package. Everything else was introduced by our layers.
    jq -n --slurpfile img "$OUT_PREFIX.json" --slurpfile base "$BASE_JSON" '
      [ ($base[0].Results[]? | .Vulnerabilities[]? | "\(.VulnerabilityID)\t\(.PkgName)") ] as $b
      | { Results: [ $img[0].Results[]? | { Target, Class, Type,
            Vulnerabilities: [ .Vulnerabilities[]?
              | select( ("\(.VulnerabilityID)\t\(.PkgName)") as $k | ($b | index($k)) == null ) ] }
          | select(.Vulnerabilities | length > 0) ] }' > "$NEW_JSON"
else
    cp "$OUT_PREFIX.json" "$NEW_JSON"
fi

TOTAL="$(findings "$OUT_PREFIX.json")"
NEW="$(findings "$NEW_JSON")"
DEPS=0
[[ -n "$DEPS_JSON" ]] && DEPS="$(findings "$DEPS_JSON")"

render() {  # render <json> <label>
    local f="$1" label="$2"
    jq -r --arg l "$label" '
      .Results[]? | select(.Vulnerabilities) | . as $r
      | .Vulnerabilities[] | [$l, .PkgName, .InstalledVersion, .FixedVersion // "-",
          .Status // "-", .VulnerabilityID, ($r.Class)] | @tsv' "$f" 2>/dev/null \
      | awk -F'\t' '{
          key=$2" "$3" "$5
          if (!(key in seen)) { seen[key]=1; order[++n]=key; line[key]=sprintf("%-14s %-26s %-22s %-22s %-9s %s", $1, $2, $3, $4, $5, $6) }
          else if (index(line[key], $6) == 0) { line[key]=line[key] "," $6 }
        }
        END {
          printf "%-14s %-26s %-22s %-22s %-9s %s\n", "SOURCE", "PACKAGE", "INSTALLED", "FIXED", "STATUS", "CVE"
          printf "%-14s %-26s %-22s %-22s %-9s %s\n", "------", "-------", "---------", "-----", "------", "---"
          for (i=1;i<=n;i++) print line[order[i]]
        }'
}

{
    echo
    echo "======================= security gate: $IMAGE"
    echo "trivy $TRIVY_IMAGE   severity=$SEVERITIES   gate=$GATE_MODE$([[ "$IGNORE_UNFIXED" == 1 ]] && echo '   (ignore-unfixed)')"
    [[ -f "$IGNORE_FILE" ]] && echo "accepted risks: $IGNORE_FILE"
    echo
    render "$OUT_PREFIX.json" "image"
    if [[ -n "$BASE_JSON" ]]; then
        echo
        echo "base image: $BASE_IMAGE"
        render "$BASE_JSON" "base"
    fi
    if [[ -n "$DEPS_JSON" ]]; then
        echo
        render "$DEPS_JSON" "deps"
    fi
    echo
    printf 'critical findings — image: %s   introduced by this image: %s   deps: %s\n' "$TOTAL" "$NEW" "$DEPS"
    echo "reports: $OUT_PREFIX.json${BASE_JSON:+ $BASE_JSON}${DEPS_JSON:+ $DEPS_JSON} $NEW_JSON"
} | tee "$OUT_PREFIX.txt"

gate_failed=0
case "$GATE_MODE" in
    none) ;;
    strict) [[ "$TOTAL" -gt 0 ]] && gate_failed=1 ;;
    new)    [[ "$NEW" -gt 0 ]] && gate_failed=1 ;;
    *) echo "error: unknown gate mode '$GATE_MODE'" >&2; exit 2 ;;
esac
[[ "$DEPS" -gt 0 ]] && gate_failed=1

# Clean up the exported tarball, if any.
rm -f "$OUT_PREFIX.tar"

if [[ "$gate_failed" -eq 1 ]]; then
    cat <<EOF

RELEASE BLOCKED — $TOTAL critical finding(s) in the image ($NEW not explained by the
base image), $DEPS in dependency lockfile.

Each one must either be fixed or explicitly accepted, with a justification and an
expiry date, in $IGNORE_FILE. Triage checklist:
  1. Introduced by this image  -> fix it here (bump the pinned package / base image).
  2. Inherited from the base   -> bump cloudron/base (5.0.0 ships 133 criticals,
                                 6.0.1 ships 14) or accept with an expiry date.
  3. Dependency finding        -> bump the dependency (deps are scanned from
                                 bun.lock; Trivy cannot read bun.lockb directly).

Full report: $OUT_PREFIX.json
EOF
    exit 1
fi

echo
echo "GATE PASSED — no unaccepted critical findings."
