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
set -Eeuo pipefail
# Unexpected tooling/I/O errors are infrastructure failures, never finding exits.
trap 'echo "error: security gate could not complete (line $LINENO)" >&2; exit 2' ERR

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
OFFLINE_SCAN="${OFFLINE_SCAN:-0}"
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

case "$GATE_MODE" in strict|new|none) ;; *) echo "error: invalid gate mode" >&2; exit 2 ;; esac
[[ -n "$IMAGE" ]] || { echo "error: no image reference given" >&2; usage 2; }
command -v bun >/dev/null || { echo "error: bun is required for report and acceptance validation" >&2; exit 2; }
command -v jq >/dev/null || { echo "error: jq is required" >&2; exit 2; }

# Fail fast on a bad acceptance file, before any image export or scan.
if [[ -f "$IGNORE_FILE" ]]; then
    bun scripts/lib/security-report.ts validate-ignore "$IGNORE_FILE" \
        || { echo "error: invalid acceptance file: $IGNORE_FILE" >&2; exit 2; }
fi

mkdir -p "$CACHE_DIR" "$REPORTS_DIR"
STAMP="$(date -u +%Y%m%d-%H%M%S)-$$"
SLUG="$(printf '%s' "$IMAGE" | tr '/:@' '___')"
RUN_DIR="$(mktemp -d "$REPORTS_DIR/run-$STAMP-XXXXXX")"
OUT_PREFIX="$RUN_DIR/trivy-$SLUG"
infra() { echo "error: $*" >&2; exit 2; }
# Always write into a fresh directory; a previous run can never supply a report.
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"; rm -f "$OUT_PREFIX.tar" "$OUT_PREFIX.base.tar"' EXIT

derive_report() {
    bun scripts/lib/security-report.ts derive "$1" "$2" || infra "unusable Trivy report: $1"
}
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

OFFLINE_ARGS=()
[[ "$OFFLINE_SCAN" == 1 ]] && OFFLINE_ARGS=(--skip-db-update --skip-java-db-update --offline-scan)

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
        "$TRIVY_IMAGE" "$@" "${scan_args[@]}" "${IGNORE_ARGS[@]}" "${OFFLINE_ARGS[@]}"
}

# ---------------------------------------------------------------- scan

scan_image() {  # scan_image <image-or---input=PATH> <out.json> ; exit code preserved
    local target="$1" out="$2"
    local args=(image --show-suppressed --exit-code 0 --format json -o "/scan/${out#"$REPO_ROOT"/}")
    if [[ "$target" == --input=* ]]; then
        trivy "${args[@]}" --input "${target#--input=}"
    else
        trivy "${args[@]}" "$target"
    fi
}

FULL_JSON="$OUT_PREFIX.full.json"
GATE_JSON="$OUT_PREFIX.gate.json"
if [[ ${#SOCK_VOL[@]} -eq 0 ]]; then
    scan_image "--input=/scan/$OUT_PREFIX.tar" "$FULL_JSON" || infra "image scan failed"
else
    scan_image "$IMAGE" "$FULL_JSON" || infra "image scan failed"
fi
derive_report "$FULL_JSON" "$GATE_JSON"
# Keep the historical filename, now explicitly the suppression-aware full report.
cp "$FULL_JSON" "$OUT_PREFIX.json"

# ---------------------------------------------------------------- base-image diff

BASE_JSON=""
BASE_UNAVAILABLE=0
if [[ -z "$BASE_IMAGE" && -f Dockerfile ]]; then
    BASE_IMAGE="$(awk 'toupper($1)=="FROM"{print $2; exit}' Dockerfile | sed 's/^--platform=[^ ]* //')"
fi

# Runs under `if`, so errexit/ERR are suppressed: every step reports via BASE_ERR.
base_attribution() {
    local full="$OUT_PREFIX.base.full.json"
    if [[ ${#SOCK_VOL[@]} -eq 0 ]]; then
        "$RUNNER" save -o "$OUT_PREFIX.base.tar" "$BASE_IMAGE" || { BASE_ERR="base image export failed"; return 1; }
        scan_image "--input=/scan/$OUT_PREFIX.base.tar" "$full" || { BASE_ERR="base scan failed"; return 1; }
    else
        scan_image "$BASE_IMAGE" "$full" || { BASE_ERR="base scan failed"; return 1; }
    fi
    bun scripts/lib/security-report.ts derive "$full" "$OUT_PREFIX.base.json" || { BASE_ERR="unusable Trivy report: $full"; return 1; }
}

if [[ -n "$BASE_IMAGE" ]]; then
    echo "==> Scanning base image for attribution: $BASE_IMAGE"
    BASE_ERR=""
    if base_attribution; then
        BASE_JSON="$OUT_PREFIX.base.json"
    elif [[ "$GATE_MODE" == "new" ]]; then
        infra "$BASE_ERR"   # attribution is the gate in this mode
    else
        echo "warn: base image attribution unavailable ($BASE_ERR); introduced count not computed" >&2
        BASE_UNAVAILABLE=1
        rm -f "$OUT_PREFIX.base.json" "$OUT_PREFIX.base.full.json"
    fi
fi

# ---------------------------------------------------------------- dependency scan

DEPS_JSON=""
if [[ "$SCAN_DEPS" == "1" ]]; then
    DEPS_JSON="$OUT_PREFIX.deps.json"
    tmp="$TMP_DIR"
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
        infra "no usable bun lockfile found (use --no-deps only for an intentional partial scan)"
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
            "$TRIVY_IMAGE" fs --scanners vuln --show-suppressed --exit-code 0 --format json \
            --severity "$SEVERITIES" "${IGNORE_ARGS[@]}" "${OFFLINE_ARGS[@]}" \
            -o "/scan/${DEPS_JSON%.json}.full.json" /deps || infra "dependency scan failed"
        derive_report "${DEPS_JSON%.json}.full.json" "$DEPS_JSON"
    fi
fi

# ---------------------------------------------------------------- report

WARNING_REPORT="$OUT_PREFIX.warnings.txt"
: > "$WARNING_REPORT"
if [[ -f "$IGNORE_FILE" ]]; then
    warning_inputs=("$FULL_JSON")
    [[ -n "$DEPS_JSON" ]] && warning_inputs+=("${DEPS_JSON%.json}.full.json")
    bun scripts/lib/security-report.ts warnings "$IGNORE_FILE" "${warning_inputs[@]}" > "$WARNING_REPORT" \
        || infra "acceptance validation failed"
fi

findings() { jq -er '[.Results[]?|.Vulnerabilities[]?]|length' "$1" || infra "cannot count findings in $1"; }

NEW_JSON="$OUT_PREFIX.new.json"
if [[ -n "$BASE_JSON" ]]; then
    # A finding is "inherited" when the base image has a CRITICAL with the same
    # CVE in the same package. Everything else was introduced by our layers.
    jq -n --slurpfile img "$GATE_JSON" --slurpfile base "$BASE_JSON" '
      [ ($base[0].Results[]? | .Vulnerabilities[]? | "\(.VulnerabilityID)\t\(.PkgName)") ] as $b
      | { Results: [ $img[0].Results[]? | { Target, Class, Type,
            Vulnerabilities: [ .Vulnerabilities[]?
              | select( ("\(.VulnerabilityID)\t\(.PkgName)") as $k | ($b | index($k)) == null ) ] }
          | select(.Vulnerabilities | length > 0) ] }' > "$NEW_JSON"
else
    cp "$GATE_JSON" "$NEW_JSON"
fi

TOTAL="$(findings "$GATE_JSON")"
NEW="$(findings "$NEW_JSON")"
NEW_LABEL="$NEW"
[[ "$BASE_UNAVAILABLE" == 1 ]] && NEW_LABEL="n/a"
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
    echo "scope: severity=$SEVERITIES ignore-unfixed=$IGNORE_UNFIXED deps=$SCAN_DEPS; full means within this scope"
    echo
    render "$GATE_JSON" "image"
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
    accepted_inputs=("$FULL_JSON")
    [[ -n "$DEPS_JSON" ]] && accepted_inputs+=("${DEPS_JSON%.json}.full.json")
    echo "Accepted findings (image and dependency scans; statement is the owning rationale):"
    jq -r '.Results[]? | . as $r | .ExperimentalModifiedFindings[]? |
      ["accepted", $r.Target, .Finding.PkgName, .Finding.VulnerabilityID, .Statement] | @tsv' "${accepted_inputs[@]}"
    ACCEPTED="$(jq -s '[.[].Results[]? | .ExperimentalModifiedFindings[]?] | length' "${accepted_inputs[@]}")"
    printf 'findings (selected severities) — unaccepted image: %s   accepted (image + deps): %s   introduced: %s   unaccepted deps: %s\n' "$TOTAL" "$ACCEPTED" "$NEW_LABEL" "$DEPS"
    cat "$WARNING_REPORT"
    echo "reports: $FULL_JSON $GATE_JSON${BASE_JSON:+ $BASE_JSON}${DEPS_JSON:+ $DEPS_JSON} $NEW_JSON (dependency/base *.full.json retain suppressions)"
} | tee "$OUT_PREFIX.txt"

gate_failed=0
case "$GATE_MODE" in
    none) ;;
    strict) [[ "$TOTAL" -gt 0 ]] && gate_failed=1 ;;
    new)    [[ "$NEW" -gt 0 ]] && gate_failed=1 ;;
    *) echo "error: unknown gate mode '$GATE_MODE'" >&2; exit 2 ;;
esac
[[ "$DEPS" -gt 0 ]] && gate_failed=1

if [[ "$gate_failed" -eq 1 ]]; then
    cat <<EOF

RELEASE BLOCKED — $TOTAL critical finding(s) in the image ($NEW_LABEL not explained by the
base image), $DEPS in dependency lockfile.

Each one must either be fixed or explicitly accepted, with a justification and an
expiry date, in $IGNORE_FILE. Triage checklist:
  1. Introduced by this image  -> fix it here (bump the pinned package / base image).
  2. Inherited from the base   -> bump cloudron/base (5.0.0 ships 133 criticals,
                                 6.0.1 ships 14) or accept with an expiry date.
  3. Dependency finding        -> bump the dependency (deps are scanned from
                                 bun.lock; Trivy cannot read bun.lockb directly).

Full report: $FULL_JSON
EOF
    exit 1
fi

echo
echo "GATE PASSED — no unaccepted critical findings."
