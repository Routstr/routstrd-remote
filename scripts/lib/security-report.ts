import { readFileSync, writeFileSync } from "node:fs";

// Pinned Trivy 0.76.1: --show-suppressed leaves gate findings in
// Vulnerabilities and puts ignored entries in ExperimentalModifiedFindings.
export function validateReport(report: any) {
  if (report?.SchemaVersion !== 2 || typeof report.ArtifactName !== "string" ||
      typeof report.ArtifactType !== "string" || (report.Results != null && !Array.isArray(report.Results))) {
    throw new Error("invalid Trivy report envelope");
  }
  // Trivy omits Results entirely when nothing was scanned or found.
  for (const result of report.Results ?? []) {
    if (!result || typeof result.Target !== "string") throw new Error("invalid result");
    for (const key of ["Vulnerabilities", "ExperimentalModifiedFindings"]) {
      if (result[key] != null && !Array.isArray(result[key])) throw new Error(`invalid ${key}`);
    }
    for (const finding of result.Vulnerabilities ?? []) validateFinding(finding);
    for (const modified of result.ExperimentalModifiedFindings ?? []) {
      if (modified.Type !== "vulnerability" || modified.Status !== "ignored" ||
          (modified.Statement != null && typeof modified.Statement !== "string")) throw new Error("unknown suppression schema");
      validateFinding(modified.Finding);
    }
  }
  return report;
}

function validateFinding(finding: any) {
  for (const key of ["VulnerabilityID", "PkgName", "Severity"]) {
    if (typeof finding?.[key] !== "string" || !finding[key]) throw new Error(`invalid finding ${key}`);
  }
}

export function gateReport(report: any) {
  validateReport(report);
  return { ...report, Results: (report.Results ?? []).map(({ ExperimentalModifiedFindings, ...result }: any) => result) };
}

// One place for acceptance-entry rules; a missing/null `vulnerabilities` key
// (or an empty file) is valid, other Trivy ignorefile sections are not ours.
export function validateIgnore(ignore: any) {
  if (ignore == null) return [];
  if (typeof ignore !== "object" || Array.isArray(ignore)) throw new Error("invalid vulnerability ignorefile");
  if (ignore.vulnerabilities == null) return [];
  if (!Array.isArray(ignore.vulnerabilities)) throw new Error("invalid vulnerability ignorefile");
  return ignore.vulnerabilities.map((entry: any) => {
    if (typeof entry?.id !== "string" || typeof entry.statement !== "string" || !entry.statement.trim() ||
        typeof entry.expiredAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.expiredAt)) {
      throw new Error("each acceptance requires id, statement, and expiredAt (YYYY-MM-DD)");
    }
    const expiry = Date.parse(`${entry.expiredAt}T00:00:00Z`);
    if (!Number.isFinite(expiry) || new Date(expiry).toISOString().slice(0, 10) !== entry.expiredAt) {
      throw new Error(`invalid expiry for ${entry.id}`);
    }
    return { id: entry.id as string, expiredAt: entry.expiredAt as string, expiry };
  });
}

export function acceptanceWarnings(ignore: any, reports: any[], now = new Date()) {
  const entries = validateIgnore(ignore);
  const observed = new Set<string>();
  for (const report of reports) {
    validateReport(report);
    for (const result of report.Results ?? []) {
      for (const f of result.Vulnerabilities ?? []) observed.add(f.VulnerabilityID);
      for (const f of result.ExperimentalModifiedFindings ?? []) observed.add(f.Finding.VulnerabilityID);
    }
  }
  const warnings: string[] = [];
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (const entry of entries) {
    const { expiry } = entry;
    const days = (expiry - today) / 86400000;
    if (expiry <= now.getTime()) warnings.push(`EXPIRED ACCEPTANCE: ${entry.id} (${entry.expiredAt}) — Trivy no longer honours this exception`);
    else if (days <= 7) warnings.push(`ACCEPTANCE EXPIRES WITHIN 7 DAYS: ${entry.id} (${entry.expiredAt})`);
    else if (days <= 30) warnings.push(`ACCEPTANCE EXPIRES WITHIN 30 DAYS: ${entry.id} (${entry.expiredAt})`);
    if (!observed.has(entry.id)) warnings.push(`STALE ACCEPTANCE: ${entry.id} — not observed in completed image/dependency scan scope; review before removal (filters, package paths and skipped dependency scans may explain absence)`);
  }
  return warnings;
}

if (import.meta.main) {
  try {
    const [command, file, ...args] = process.argv.slice(2);
    const load = (path: string) => JSON.parse(readFileSync(path, "utf8"));
    if (command === "derive") {
      writeFileSync(args[0], JSON.stringify(gateReport(load(file)), null, 2) + "\n");
    } else if (command === "validate-ignore") {
      validateIgnore(Bun.YAML.parse(readFileSync(file, "utf8")));
    } else if (command === "warnings") {
      const ignore = Bun.YAML.parse(readFileSync(file, "utf8"));
      for (const warning of acceptanceWarnings(ignore, args.map(load))) console.log(warning);
    } else throw new Error("unknown report command");
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  }
}
