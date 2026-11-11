#!/usr/bin/env bash
#
# scripts/publish-catalog.sh — mirror CloudronVersions.json to the Vercel-hosted
# copy that routstr.com serves, so the catalog URL the app points at is not on
# GitHub.
#
# The catalog is read by every instance on its update check, so it has to live
# somewhere reliable and be updated as part of the release — not hand-copied.
# This script is the "publish" half of that: run it after `cloudron versions
# add`, review the diff it prints, and it commits + pushes the landingpage repo,
# which triggers the Vercel deploy.
#
#   ./scripts/publish-catalog.sh                 # copy, verify, commit, push
#   ./scripts/publish-catalog.sh --dry-run       # copy + verify, no commit/push
#   ./scripts/publish-catalog.sh --check         # verify only; exit 1 if stale
#   ./scripts/publish-catalog.sh --landingpage <path>
#
# Why a copy at all: routstr.com is a Next.js app on Vercel, and `public/` is
# served as-is. A build-time fetch was rejected deliberately — a fetch that
# fails open would silently serve the *previous* catalog, which is worse than a
# release step that fails loudly.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$REPO_ROOT/CloudronVersions.json"

LANDINGPAGE="${LANDINGPAGE_DIR:-$REPO_ROOT/../landingpage}"
DEST_REL="public/CloudronVersions.json"

DO_COMMIT=1
DRY_RUN=0
CHECK_ONLY=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --landingpage) LANDINGPAGE="${2:?--landingpage needs a path}"; shift 2 ;;
        --no-commit) DO_COMMIT=0; shift ;;
        --dry-run) DO_COMMIT=0; DRY_RUN=1; shift ;;
        --check) CHECK_ONLY=1; DO_COMMIT=0; shift ;;
        -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown flag: $1" >&2; exit 2 ;;
    esac
done

die() { echo "error: $*" >&2; exit 1; }

[[ -f "$SOURCE" ]] || die "$SOURCE not found — run this from the routstrd-remote checkout"
[[ -d "$LANDINGPAGE/.git" ]] || die "no git repo at $LANDINGPAGE (set --landingpage or LANDINGPAGE_DIR)"
DEST="$LANDINGPAGE/$DEST_REL"

# Verify the source is a catalog we would be happy to serve before touching the
# destination: a truncated or half-edited file here is a user-facing outage.
summarize() {
    python3 - "$1" <<'PY'
import json, sys
path = sys.argv[1]
with open(path) as fh:
    data = json.load(fh)

if "stable" not in data or "versions" not in data:
    sys.exit(f"{path}: missing 'stable' or 'versions'")

versions = data["versions"]
if not versions:
    sys.exit(f"{path}: empty versions map")

newest = list(versions)[-1]
manifest = versions[newest]["manifest"]
print(f"entries={len(versions)} newest={newest} "
      f"image={manifest.get('dockerImage', 'MISSING')} "
      f"minBox={manifest.get('minBoxVersion', 'MISSING')}")
PY
}

SOURCE_SUMMARY="$(summarize "$SOURCE")" || die "source catalog is unusable (see above)"
echo "==> Source $SOURCE"
echo "    $SOURCE_SUMMARY"

if [[ "$CHECK_ONLY" == "1" ]]; then
    if [[ ! -f "$DEST" ]]; then
        echo "STALE: $DEST does not exist" >&2
        exit 1
    fi
    if cmp -s "$SOURCE" "$DEST"; then
        echo "IN SYNC: $DEST"
        exit 0
    fi
    echo "STALE: $DEST differs from $SOURCE" >&2
    echo "  destination: $(summarize "$DEST" || echo '(unparseable)')" >&2
    exit 1
fi

cp "$SOURCE" "$DEST"

# Re-read the destination rather than trusting the copy: this is the file the
# CDN will serve, and a partial write would be worse than no deploy at all.
DEST_SUMMARY="$(summarize "$DEST")" || die "copied catalog at $DEST is unusable (see above)"
[[ "$SOURCE_SUMMARY" == "$DEST_SUMMARY" ]] \
    || die "copy mismatch: source [$SOURCE_SUMMARY] destination [$DEST_SUMMARY]"

echo "==> Wrote $DEST"
echo "    $DEST_SUMMARY"

cd "$LANDINGPAGE"
if git diff --quiet -- "$DEST_REL" && ! git ls-files --error-unmatch "$DEST_REL" >/dev/null 2>&1; then
    echo "==> Already in sync; nothing to commit."
    exit 0
fi

echo
echo "==> Diff in $LANDINGPAGE ($DEST_REL)"
git --no-pager diff --stat -- "$DEST_REL"

if [[ "$DRY_RUN" == "1" ]]; then
    echo
    echo "Dry run: copied and verified, not committed (--dry-run)."
    exit 0
fi

if [[ "$DO_COMMIT" == "0" ]]; then
    echo
    echo "Copied and verified; not committed (--no-commit)."
    exit 0
fi

# Only ever stage this one file: the landingpage checkout is shared with normal
# content work and must not pick up unrelated changes from this script.
VERSION="$(python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(list(d['versions'])[-1])" "$SOURCE")"
git add -- "$DEST_REL"
git commit -q -m "chore(catalog): mirror CloudronVersions.json for ${VERSION}

Copied from Routstr/routstrd-remote@$(git -C "$REPO_ROOT" rev-parse --short HEAD)
by scripts/publish-catalog.sh. This is the copy routstr.com serves; it is
generated from the canonical file in the app repo, not edited by hand."
echo "==> Committed in $LANDINGPAGE"

if [[ "${PUSH:-1}" == "1" ]]; then
    git push
    echo "==> Pushed; Vercel will deploy $DEST_REL"
else
    echo "PUSH=0: not pushed."
fi

echo
echo "Verify once deployed:"
echo "  curl -s https://routstr.com/CloudronVersions.json | python3 -c \\"
echo "    'import json,sys;d=json.load(sys.stdin);print(len(d[\"versions\"]), list(d[\"versions\"])[-1])'"
