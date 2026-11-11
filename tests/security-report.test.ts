import { expect, test } from "bun:test";
import { acceptanceWarnings, gateReport, validateReport } from "../scripts/lib/security-report";

const finding = { VulnerabilityID: "CVE-A", PkgName: "pkg", Severity: "CRITICAL" };
const report = (v: any[] = [], m: any[] = []) => ({ SchemaVersion: 2, ArtifactName: "image", ArtifactType: "container_image", Results: [{ Target: "image", Vulnerabilities: v, ExperimentalModifiedFindings: m }] });
const modified = { Type: "vulnerability", Status: "ignored", Statement: "owned rationale", Finding: finding };
const entry = (id = "CVE-A", expiredAt = "2026-12-01") => ({ id, expiredAt, statement: "owned rationale" });
const now = new Date("2026-11-01T12:00:00Z");

test("suppression-aware report retains identical unaccepted findings", () => {
  const full = report([finding], [modified]);
  expect(gateReport(full).Results[0].Vulnerabilities).toEqual([finding]);
  expect(gateReport(full).Results[0].ExperimentalModifiedFindings).toBeUndefined();
  expect(full.Results[0].ExperimentalModifiedFindings).toEqual([modified]);
});

test("reject malformed reports and unknown suppression schema", () => {
  for (const value of [null, {}, { Results: [] }, { ...report(), Results: null }, report([{}]), report([], [{ ...modified, Status: "unknown" }]), report([], [{ ...modified, Finding: {} }])]) {
    expect(() => validateReport(value)).toThrow();
  }
});

test("stale uses image and dependency observations, including accepted findings", () => {
  expect(acceptanceWarnings({ vulnerabilities: [entry()] }, [report([], [modified])], now)).not.toContain(expect.stringContaining("STALE"));
  expect(acceptanceWarnings({ vulnerabilities: [entry()] }, [report(), report([finding])], now).some(w => w.startsWith("STALE"))).toBe(false);
  expect(acceptanceWarnings({ vulnerabilities: [entry()] }, [report()], now).some(w => w.includes("not observed in completed"))).toBe(true);
});

test("30/7-day and expired warnings are distinct UTC boundaries", () => {
  const warnings = (date: string) => acceptanceWarnings({ vulnerabilities: [entry("CVE-A", date)] }, [report([finding])], now);
  expect(warnings("2026-12-02")).toEqual([]);
  expect(warnings("2026-12-01")[0]).toContain("WITHIN 30 DAYS");
  expect(warnings("2026-11-08")[0]).toContain("WITHIN 7 DAYS");
  expect(warnings("2026-11-01")[0]).toContain("EXPIRED ACCEPTANCE");
  expect(() => warnings("2026-02-30")).toThrow();
});
