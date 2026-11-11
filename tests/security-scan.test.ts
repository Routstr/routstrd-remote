import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const finding = { VulnerabilityID: "CVE-A", PkgName: "pkg", InstalledVersion: "1", Severity: "CRITICAL" };
const report = (v: any[] = [], m: any[] = []) => ({ SchemaVersion: 2, ArtifactName: "fixture", ArtifactType: "container_image", Results: [{ Target: "fixture", Vulnerabilities: v, ExperimentalModifiedFindings: m }] });

const noResults = { SchemaVersion: 2, ArtifactName: "fixture", ArtifactType: "filesystem" };
const ignoreYaml = 'vulnerabilities:\n  - id: CVE-A\n    statement: fixture rationale\n    expiredAt: "2027-01-31"\n';

function run(mode: string, failure = "", image: any = report(), base: any = report(), deps: any = report(), scanDeps = false, ignore = ignoreYaml) {
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
    writeFileSync(join(root, ".trivyignore.yaml"), ignore);
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

test("image and deps scanner failures exit 2 in every mode", () => {
  for (const kind of ["image", "deps"]) {
    for (const failure of ["failed", "missing", "malformed"]) {
      for (const mode of ["strict", "new", "none"]) {
        const result = run(mode, `${kind}-${failure}`, report(), report(), report(), true);
        expect(result.code, `${mode} ${kind}-${failure}: ${result.text}`).toBe(2);
        expect(result.text).not.toContain("GATE PASSED");
      }
    }
  }
});

test("base attribution failure is fatal only under --gate new", () => {
  for (const failure of ["failed", "missing", "malformed"]) {
    const fatal = run("new", `base-${failure}`, report(), report(), report(), true);
    expect(fatal.code, `new base-${failure}: ${fatal.text}`).toBe(2);
    expect(fatal.text).not.toContain("GATE PASSED");
    for (const mode of ["strict", "none"]) {
      const result = run(mode, `base-${failure}`, report(), report(), report(), true);
      expect(result.code, `${mode} base-${failure}: ${result.text}`).toBe(0);
      expect(result.text).toContain("warn: base image attribution unavailable (");
      expect(result.text).toContain("introduced count not computed");
      expect(result.text).toContain("introduced: n/a");
    }
  }
  // Without attribution, real findings still gate under strict and are not called "introduced".
  const blocked = run("strict", "base-failed", report([finding]));
  expect(blocked.code).toBe(1);
  expect(blocked.text).toContain("introduced: n/a");
  expect(run("none", "", report()).text).not.toContain("n/a");
});

test("a report without a Results key is a clean scan", () => {
  const result = run("strict", "", noResults, noResults, noResults, true);
  expect(result.code, result.text).toBe(0);
  expect(result.text).toContain("GATE PASSED");
  expect(result.text).toContain("introduced: 0");
  expect(run("new", "", report(), report(), noResults, true).code).toBe(0);
});

test("bad acceptance file fails fast with a clear error before any scan", () => {
  for (const bad of ['vulnerabilities:\n  - id: CVE-A\n    expiredAt: "2027-01-31"\n', 'vulnerabilities:\n  - id: CVE-A\n    statement: x\n    expiredAt: "2027-02-30"\n', "vulnerabilities: nope\n"]) {
    const result = run("strict", "", report(), report(), report(), true, bad);
    expect(result.code, result.text).toBe(2);
    expect(result.text).toContain("invalid acceptance file");
    expect(result.text).not.toContain("Scanning");
    expect(result.text).not.toContain("exporting image");
    expect(result.text).not.toContain("unknown suppression schema");
  }
});

test("acceptance file without a vulnerabilities key is valid", () => {
  for (const ignore of ["misconfigurations:\n  - id: AVD-1\n", "", "# nothing accepted\n"]) {
    const result = run("strict", "", report(), report(), report(), true, ignore);
    expect(result.code, result.text).toBe(0);
    expect(result.text).toContain("GATE PASSED");
  }
});

test("accepted finding without a Statement does not break report derivation", () => {
  const result = run("strict", "", report([], [{ Type: "vulnerability", Status: "ignored", Finding: finding }]));
  expect(result.code, result.text).toBe(0);
  expect(result.text).toContain("accepted (image + deps): 1");
});
