import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const finding = { VulnerabilityID: "CVE-A", PkgName: "pkg", InstalledVersion: "1", Severity: "CRITICAL" };
const report = (v: any[] = [], m: any[] = []) => ({ SchemaVersion: 2, ArtifactName: "fixture", ArtifactType: "container_image", Results: [{ Target: "fixture", Vulnerabilities: v, ExperimentalModifiedFindings: m }] });

function run(mode: string, failure = "", image = report(), base = report(), deps = report(), scanDeps = false) {
  const root = mkdtempSync(join(tmpdir(), "security-scan-"));
  try {
    mkdirSync(join(root, "scripts/lib"), { recursive: true });
    for (const file of ["scripts/security-scan.sh", "scripts/lib/security-report.ts"]) cpSync(resolve(file), join(root, file));
    mkdirSync(join(root, "bin"));
    // A valid report from an earlier invocation must not rescue a missing scan.
    mkdirSync(join(root, "reports/run-old"), { recursive: true });
    writeFileSync(join(root, "reports/run-old/trivy-fixture-image.full.json"), JSON.stringify(report()));
    writeFileSync(join(root, "reports/trivy-fixture-image.json"), JSON.stringify(report()));
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, "bun.lock"), "{}");
    writeFileSync(join(root, ".trivyignore.yaml"), 'vulnerabilities:\n  - id: CVE-A\n    statement: fixture rationale\n    expiredAt: "2027-01-31"\n');
    for (const [key, value] of Object.entries({ image, base, deps })) writeFileSync(join(root, `${key}.json`), JSON.stringify(value));
    writeFileSync(join(root, "bin/podman"), `#!/usr/bin/env bash
set -eu
if [[ "$1" == save ]]; then touch "$3"; exit 0; fi
out=""; kind=image
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) out="$2"; shift 2;;
    fs) kind=deps; shift;;
    *) shift;;
  esac
done
[[ "$out" == *base.full.json ]] && kind=base
out="\${out#/scan/}"
if [[ "$FAILURE" == "$kind-failed" ]]; then cp "$kind.json" "$out"; exit 1; fi
if [[ "$FAILURE" == "$kind-missing" ]]; then exit 0; fi
if [[ "$FAILURE" == "$kind-malformed" ]]; then echo '{}' > "$out"; exit 0; fi
cp "$kind.json" "$out"
`);
    chmodSync(join(root, "bin/podman"), 0o755);
    const result = Bun.spawnSync(["bash", "scripts/security-scan.sh", "fixture-image", "--base", "fixture-base", "--gate", mode], {
      cwd: root, env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, FAILURE: failure, SCAN_MODE: "tar", SCAN_DEPS: scanDeps ? "1" : "0", REPORTS_DIR: "reports" },
    });
    return { code: result.exitCode, text: result.stdout.toString() + result.stderr.toString() };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("accepted findings remain visible but do not block", () => {
  const result = run("strict", "", report([], [{ Type: "vulnerability", Status: "ignored", Statement: "fixture rationale", Finding: finding }]));
  expect(result.code).toBe(0);
  expect(result.text).toContain("accepted (image + deps): 1");
  expect(result.text).toContain("fixture rationale");
});

test("strict/new/none preserve attribution and gate policy", () => {
  expect(run("strict", "", report([finding]), report([finding])).code).toBe(1);
  expect(run("new", "", report([finding]), report([finding])).code).toBe(0);
  expect(run("new", "", report([finding])).code).toBe(1);
  expect(run("none", "", report([finding])).code).toBe(0);
  expect(run("none", "", report(), report(), report([finding]), true).code).toBe(1);
  expect(run("strict").text).toContain("STALE ACCEPTANCE");
});

test("every mandatory scanner rejects failed, missing and malformed reports", () => {
  for (const kind of ["image", "base", "deps"]) {
    for (const failure of ["failed", "missing", "malformed"]) {
      const result = run("none", `${kind}-${failure}`, report(), report(), report(), true);
      expect(result.code, `${kind}-${failure}: ${result.text}`).toBe(2);
      expect(result.text).not.toContain("GATE PASSED");
    }
  }
});
