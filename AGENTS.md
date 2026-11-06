# AGENTS.md — Publishing & Version Updates

How to ship a new release of this package to Cloudron. This documents the system
as it actually behaves today (verified against the Cloudron CLI 9.0.3 source and a
real 0.1.29 release), including the traps that cost time.

---

## 1. The moving parts

| Piece | Value |
|---|---|
| This working directory | `routstrd-auth/` |
| GitHub repo | `Routstr/routstrd-remote` (**renamed** from `Routstr/routstrd-auth`) |
| GHCR image | `ghcr.io/sh1ftred/routstrd-pro` |
| Cloudron app id | `io.routstr.routstrd-auth` |
| Branch the instance pulls from | `cloudron` (via the raw `CloudronVersions.json` URL) |
| Release catalog | `CloudronVersions.json` (repo root) |

**Publishing a version requires four things:** an image pushed to a registry, that
image passing the Trivy security gate (section 7), a new entry in
`CloudronVersions.json`, and that file pushed to the `cloudron` branch. There is no
CI that does any of this — it is all manual from a workstation, which is why the
gate is a script that `scripts/publish-image.sh` always runs before pushing.

### The image name is not the repo name

The GHCR package is called `routstrd-pro`, not `routstrd-auth`/`routstrd-remote`.
That is intentional/historical and fine. The name already changed once: 0.1.0–0.1.12
used `ghcr.io/sh1ftred/routstrd.auth`, and 0.1.13+ use `ghcr.io/sh1ftred/routstrd-pro`.
Both packages are live and both are referenced by already-published versions.

**Never rename the GHCR package.** All published versions hardcode their image
reference, and GHCR paths do **not** redirect on rename (unlike git/web URLs) —
they just stop resolving, which would break every existing install and everyone
installing an older version from the catalog. Package name and repo name are
independent; nothing needs them to match.

---

## 2. Prerequisites

```bash
npm install -g cloudron          # Cloudron CLI (9.0.3 verified)
cloudron login <cloudron-domain> # OIDC device flow; writes ~/.cloudron.json
podman login ghcr.io -u <user>   # token needs write:packages
```

- **The CLI needs no Docker.** Cloudron CLI 9.x shells out only to `tar` and `git`.
  There is no `cloudron build` command anymore — it was removed. Do not follow
  `CLOUDRON-UPDATE.md` or older docs that call `cloudron build`.
- **Podman is fine** (5.x verified, rootless). On this workstation `~/bin/docker`
  is a thin shim that execs `podman` (used by other tooling); the publish flow
  below calls `podman` directly.
- **Registry token needs `write:packages`.** A token with only `repo`/`gist`/`read:org`
  will authenticate but cannot push, and `gh api /user/packages` returns 403.
  `podman login --get-login ghcr.io` should print your username once logged in.
- **The package must be public**, or the server cannot pull it. This package is
  public — verify with an anonymous pull (step 6 below).
- **Trivy needs no install.** The release security gate (step 5b) runs Trivy from
  `docker.io/aquasec/trivy:0.76.1` via the same podman socket, caching its
  vulnerability DB in `~/.cache/trivy`. `jq` must be on PATH; nothing is added to
  the release image.

### Two ways to build; only one is available here

1. **Local build + push** (what we use). No server-side infrastructure needed.
2. **Remote build** via `cloudron builder build` — requires the **Container registry**
   app installed on the Cloudron server. Check with `cloudron list | grep -i registry`.

If no Container registry app is installed, option 2 is unavailable and the CLI has
no local-build fallback. Also note: `cloudron install`/`update` can build **on the
server** from a source tarball, but **on-server builds cannot be published** — the
catalog needs a registry-hosted image.

---

## 3. Version lives in three places

All three must be updated together:

1. `package.json` → `"version"`
2. `CloudronManifest.json` → `"version"` **and** `"upstreamVersion"`
3. `CHANGELOG` → a `[x.y.z]` section

`CloudronManifest.json` references `"changelog": "file://CHANGELOG"` and
`"postInstallMessage": "file://POSTINSTALL.md"`. These are resolved at
`versions add` time and the **resolved text** is baked into the catalog entry.

**CHANGELOG format is load-bearing.** `parseChangelog` finds the exact line
`[x.y.z]`, then collects following lines until a blank-skipped line starting with
`[`, or a section break. So:

- The header must be exactly `[0.1.29]` — no trailing text, no `##`, no `v` prefix.
- Keep a blank line before the next `[x.y.z]` header.
- Anything under the header is what users see as the update notes.

Quick check that the section parses the way Cloudron will read it:

```bash
node -e '
const fs=require("fs"), v=process.argv[1], L=fs.readFileSync("CHANGELOG","utf8").split("\n");
let i=L.indexOf("["+v+"]"); if(i<0) return console.error("missing ["+v+"]");
let o=""; for(i++;i<L.length;i++){ if(!L[i])continue; if(L[i][0]==="[")break; o+=L[i]+"\n"; }
console.log(o);' 0.1.29
```

---

## 4. Release procedure

Substitute the version and use a **clean tree**. Run the whole thing from this
directory.

### Step 1 — Preflight

```bash
git status --porcelain          # must be clean (untracked local-only files are ok)
git fetch origin
git log --oneline -1
cloudron list                   # confirm the app + its current version
```

Confirm the app's `Source` still points at the `cloudron` branch catalog URL.

### Step 2 — Write the CHANGELOG entry

Add a new `[x.y.z]` section at the top. Order entries by user impact and lead with
**money-related** items (mint recovery, mint codes, paid codes, token/balance
handling), then routing/model changes, then everything else. Skip internal
refactors, dependency bumps, and reverted/re-landed PRs.

If the release bundles new `routstrd` / `routstr-sdk` versions, summarize their
highlights rather than copying their changelogs, and keep the final
`Updated bundled routstrd to X and routstr-sdk to Y` line accurate — then **verify**
it (step 5).

### Step 3 — Bump the three version locations

### Step 4 — Commit the bump

```bash
git add CHANGELOG package.json CloudronManifest.json
git commit -m "chore: bump version to 0.1.29"
```

### Step 5 — Build, then verify the bundled dependencies

The tag format is `$(date -u +%Y%m%d-%H%M%S)-$(git rev-parse --short=9 HEAD)`.
Mint a fresh one every release — don't reuse old tags, and don't try to reverse
engineer a historical tag's suffix (the sha in older tags often isn't a commit in
this repo at all).

```bash
TAG="$(date -u +%Y%m%d-%H%M%S)-$(git rev-parse --short=9 HEAD)"
IMG="ghcr.io/sh1ftred/routstrd-pro:$TAG"
podman build -t "$IMG" . 2>&1 | tee /tmp/build.log
```

`./scripts/publish-image.sh` does build → versions printout → **security gate** →
push in one shot, so the gate cannot be skipped by accident. The manual steps below
are what it runs; use them only when debugging it.

Then **prove** what's in the image before you trust the changelog — if the
`routstrd` pin in the Dockerfile is ever loosened again it will silently track
whatever `latest` was at build time:

```bash
podman run --rm --entrypoint /usr/local/bin/routstrd "$IMG" --version
# routstrd 0.4.12

podman run --rm --entrypoint /bin/sh "$IMG" -c \
  'grep -m1 "\"version\"" /usr/local/bun/install/global/node_modules/@routstr/sdk/package.json'
#   "version": "0.4.8",
```

If these disagree with the changelog line, fix the changelog (rebuild only if the
dependency itself is wrong).

### Step 5b — Security gate (blocking)

```bash
./scripts/security-scan.sh "$IMG"        # exit 0 = publishable, 1 = blocked
```

The gate scans the built image (OS packages, the installed Node dependency tree —
655 packages including routstrd's — and Go binaries), plus this repo's own
dependencies from `bun.lock`, and **fails on any CRITICAL that is not accepted in
`.trivyignore.yaml`**. A blocked gate means: do not push, do not register a version.
See section 7 for the policy and how to triage.

`podman push` in step 6 (or `publish-image.sh`) must never run before this passes.

### Step 6 — Push and verify public pull

```bash
podman push "$IMG"
```

Then confirm it pulls **anonymously** (no credentials) — this is what the server does:

```bash
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:sh1ftred/routstrd-pro:pull&service=ghcr.io" | jq -r .token)
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.oci.image.manifest.v1+json" \
  "https://ghcr.io/v2/sh1ftred/routstrd-pro/manifests/$TAG"
# 200
```

Use an `Accept` header that includes the OCI manifest types, or GHCR answers
404 `MANIFEST_UNKNOWN` even for an existing tag.

### Step 7 — Register the version

```bash
cloudron versions add --image "$IMG"
# Added 0.1.29 in CloudronVersions.json

cloudron versions verify
# CloudronVersions.json is valid (30 version(s))
```

`versions add` reads the version from `CloudronManifest.json`, pulls the changelog
through the `file://` reference, and records the image plus timestamps. It is a
**local file operation** — it does not contact the Cloudron server, so it works
even while logged out. Without `--image` it uses the last `cloudron builder` image
(`--last-build` to skip the prompt), which won't exist on a local-build workflow.

### Step 8 — Commit the registration

```bash
git add CloudronVersions.json
git commit -m "chore: register 0.1.29 in Cloudron versions"
```

### Step 9 — Push `main`, then merge into `cloudron`

```bash
git push origin main

git fetch origin
git checkout -B cloudron origin/cloudron   # reset: cloudron routinely drifts behind
git merge main --no-edit
bun test                                   # 50 pass on 0.1.29
cloudron versions verify
git push origin cloudron
```

**The `cloudron` branch is what the instance pulls.** Pushing `main` alone does
nothing for users. Historically `cloudron` advances by merges of `main` (commits
titled `Merge pull request #N from Routstr/main`).

Local `cloudron` is often stale/divergent — reset it to `origin/cloudron` before
merging, and confirm the reset discards nothing (`git rev-list --left-right --count
cloudron...origin/cloudron` should show `0 <n>`, i.e. no local-only commits).

### Step 10 — Verify live

```bash
curl -s "https://raw.githubusercontent.com/Routstr/routstrd-remote/refs/heads/cloudron/CloudronVersions.json" \
  | jq -r '.versions["0.1.29"] | {v: .manifest.version, img: .manifest.dockerImage, state: .publishState}'
```

The old `routstrd-auth` slug also still serves the file via GitHub's rename
redirect, so either URL works.

### Step 11 — Update the running instance (optional, operator decision)

Updating restarts the live app, so **ask before doing it** unless told to proceed.

```bash
cloudron update --app <app-location>              # takes a backup first
cloudron update --app <app-location> --no-backup  # skip the backup
cloudron status --app <app-location>
```

Update through the dashboard also works; the catalog URL just needs to be present
under community apps.

---

## 5. Version lifecycle rules

- **Never edit a published version's manifest or image** — users may already have
  installed it. Ship changes as a new version.
- `--state published|testing` — `testing` registers without offering it to users.
- `cloudron versions update --version <v>` / `--image <img>` exists, but per the
  docs avoid rewriting published entries; prefer revoke + add.
- `cloudron versions revoke` marks the latest version revoked so users who haven't
  updated won't receive it.
- `cloudron versions list` shows Version / Creation Date / Image / Publish state.

---

## 6. Known traps & follow-ups

1. **Unpinned `routstrd` in the Dockerfile.** `RUN bun install --global routstrd`
   takes npm `latest` at build time, so builds aren't reproducible and the bundled
   daemon can silently change between releases. Pinning it is a worthwhile fix.
   (Now pinned to `routstrd@0.4.18` — keep it pinned and bump deliberately, the
   security gate scans that dependency tree.)
2. **Repo renamed, two stale references remain.** The local `origin` remote and the
   app's `Source` field still use the `routstrd-auth` slug. Git clone/fetch/push
   redirect fine, but **raw** content redirects are the fragile kind — repointing
   both to `routstrd-remote` is safer.
3. **No CI for this package.** The repo has no `.github/workflows`; image build and
   push are entirely manual (unlike `routstrd`, which has release workflows). Any
   automation would need to be added deliberately.
4. **Untraceable historical tags.** Tag suffixes on older releases don't correspond
   to commits in this repo. Don't depend on them for provenance.
5. **`cloudron versions add` needs the registry image to already exist.** It records
   a reference; it does not push. Pushing after registering leaves a broken entry.

---

## 7. Security gate (Trivy)

`scripts/security-scan.sh <image>` is the release gate; `scripts/publish-image.sh`
wires it between build and push. Trivy runs in its own container against the
podman socket (falling back to `podman save` → image tarball), so the release image
stays clean and nothing but `~/.cache/trivy` is written outside the repo.

What it does:

| Step | What is scanned | Why |
|---|---|---|
| image | OS packages, `node_modules` trees (bun global install), Go binaries | what Cloudron actually pulls |
| base | same scan of the `FROM` image in the Dockerfile | attributes each finding to the base image or to our layers |
| deps | `bun.lock` of this repo | Trivy cannot read the binary `bun.lockb`; the script converts a throwaway copy |

Exit codes: `0` pass, `1` blocked, `2` could not run. A missing/invalid report is
never treated as a pass. Reports land in `reports/` (gitignored): `*.json` (full),
`*.base.json`, `*.new.json` (findings our layers introduced), `*.deps.json`, `*.txt`.

Gate modes:

- `--gate strict` (default) — any CRITICAL anywhere in the image blocks.
- `--gate new` — only CRITICALs the base image does not already have block. Use
  this while a base-image bump is pending, not as a permanent setting.
- `--ignore-unfixed` — drop findings with no fix available.

### Accepted risks live in `.trivyignore.yaml`

Anything CRITICAL that ships must be listed there with a `statement` (why it is not
exploitable here, who owns the fix) and an `expiredAt` date, max 90 days out.
Expired entries stop being honoured, so the gate re-opens by itself. Never delete
entries silently — replace or extend with a new justification.

### Reading the report

```
SOURCE   PACKAGE         INSTALLED   FIXED    STATUS   CVE
base     php8.3-xml      8.3.6-...   8.3.6-…  fixed    CVE-2026-109618
image    tar             6.2.1       7.5.19   fixed    CVE-2026-59873
```

- `SOURCE=base` rows are inherited from `cloudron/base` — fix by bumping the base
  image, not by patching this Dockerfile.
- `SOURCE=image` rows mean **our** layers added them: fix here (pin/bump).
- `STATUS=fixed` means an upgrade exists; `affected` means no fix has shipped yet
  (candidate for `.trivyignore.yaml` with an expiry).

Current baseline (measured 2026-11-04, Trivy 0.76.1): `cloudron/base:5.0.0` ships
**133 CRITICALs** (php8.3-*, linux-libc-dev, mongodb tools, npm's bundled `tar`,
`gosu`), `5.1.0` 32, `6.0.0` 21, `cloudron/base:6.0.1` 14. This image adds **zero**
of its own, and its dependency tree is clean at CRITICAL. So a strict gate cannot
pass on 5.0.0 — the honest options are to bump the base image and/or accept the
remaining base-image findings with short expiries.

Bumping the base image is a real release (new Debian/Ubuntu base, new package set):
treat it as its own versioned release and re-run the gate before and after.

## 8. Conventions

- One writer per checkout; isolate concurrent work in `.worktrees/` (already in
  `.gitignore` — keep it that way).
- Don't publish from a dirty or diverged tree.
- Don't publish an image the security gate has not passed; `reports/` and
  `~/.cache/trivy` are machine-local and never committed.
- Keep the changelog's bundled-version line truthful — verify it from the built
  image rather than trusting the build.
