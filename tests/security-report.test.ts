import { expect, test } from "bun:test";
import { acceptanceWarnings, gateReport, validateIgnore, validateReport } from "../scripts/lib/security-report";

const finding = { VulnerabilityID: "CVE-A", PkgName: "pkg", Severity: "CRITICAL" };
const report = (v: any[] = [], m: any[] = []) => ({ SchemaVersion: 2, ArtifactName: "image", ArtifactType: "container_image", Results: [{ Target: "image", Vulnerabilities: v, ExperimentalModifiedFindings: m }] });
const modified = { Type: "vulnerability", Status: "ignored", Statement: "owned rationale", Finding: finding };
const entry = (id = "CVE-A", expiredAt = "2026-12-01") => ({ id, expiredAt, statement: "owned rationale" });
const noResults = { SchemaVersion: 2, ArtifactName: "dir", ArtifactType: "filesystem" };
const now = new Date("2026-11-01T12:00:00Z");

test("suppression-aware report retains identical unaccepted findings", () => {
  const full = report([finding], [modified]);
  expect(gateReport(full).Results[0].Vulnerabilities).toEqual([finding]);
  expect(gateReport(full).Results[0].ExperimentalModifiedFindings).toBeUndefined();
  expect(full.Results[0].ExperimentalModifiedFindings).toEqual([modified]);
});

test("reject malformed reports and unknown suppression schema", () => {
  for (const value of [null, {}, { Results: [] }, { ...report(), Results: "x" }, { ...report(), Results: {} }, report([{}]), report([], [{ ...modified, Status: "unknown" }]), report([], [{ ...modified, Finding: {} }])]) {
    expect(() => validateReport(value)).toThrow();
  }
});

test("report without a Results key (nothing scanned/found) is valid", () => {
  for (const value of [noResults, { ...noResults, Results: null }]) {
    expect(validateReport(value)).toBe(value);
    expect(gateReport(value).Results).toEqual([]);
    expect(acceptanceWarnings({ vulnerabilities: [entry()] }, [value], now).some(w => w.startsWith("STALE"))).toBe(true);
    expect(acceptanceWarnings({ vulnerabilities: [] }, [value], now)).toEqual([]);
  }
});

test("modified finding tolerates a missing or empty Statement but not a wrong type", () => {
  const { Statement, ...bare } = modified;
  expect(() => validateReport(report([], [bare]))).not.toThrow();
  expect(() => validateReport(report([], [{ ...modified, Statement: "" }]))).not.toThrow();
  expect(() => validateReport(report([], [{ ...modified, Statement: 1 }]))).toThrow();
  expect(() => validateReport(report([], [{ ...bare, Status: "unknown" }]))).toThrow();
  expect(() => validateReport(report([], [{ ...bare, Finding: {} }]))).toThrow();
});

test("validateIgnore shares entry rules and accepts files without vulnerabilities", () => {
  expect(validateIgnore({ vulnerabilities: [entry()] })).toHaveLength(1);
  for (const value of [null, undefined, {}, { misconfigurations: [{ id: "AVD-1" }] }, { secrets: [] }, { vulnerabilities: null }]) expect(validateIgnore(value)).toEqual([]);
  expect(acceptanceWarnings({ misconfigurations: [] }, [report()], now)).toEqual([]);
  for (const value of ["text", 3, [], { vulnerabilities: "x" }, { vulnerabilities: {} }, { vulnerabilities: [{ ...entry(), statement: " " }] }, { vulnerabilities: [{ id: "CVE-A", expiredAt: "2026-12-01" }] }, { vulnerabilities: [null] }, { vulnerabilities: [entry("CVE-A", "2026-02-30")] }]) {
    expect(() => validateIgnore(value)).toThrow();
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
