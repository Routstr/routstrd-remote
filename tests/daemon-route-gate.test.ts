import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const digest = (data: string) => createHash("sha256").update(data).digest("hex");

test("image gate requires reviewed version, bundle, proxy sources and explicit route classifications", () => {
  const root = mkdtempSync(join(tmpdir(), "route-gate-"));
  try {
    mkdirSync(join(root, "dist/daemon"), { recursive: true });
    writeFileSync(join(root, "dist/daemon/index.js"), "bundle");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "routstrd", version: "0.5.0" }));
    writeFileSync(join(root, "proxy.ts"), "proxy");
    const policy = `export const DAEMON_ROUTES = [{method:"GET",path:"/widgets/:widget",access:"member"}]`;
    writeFileSync(join(root, "daemon-routes.ts"), policy);
    const hashes = `${digest("proxy")}  src/proxy.ts\n${digest(policy)}  src/daemon-routes.ts`;
    const inventory = { version: "0.5.0", daemonBundleSha256: digest("bundle"), routes: ["GET /widgets/:id"] };
    function run(overrides = {}, sources = hashes) {
      return Bun.spawnSync([process.execPath, "scripts/lib/check-daemon-routes.ts", root, root,
        JSON.stringify({ ...inventory, ...overrides }), sources]);
    }
    expect(run().exitCode).toBe(0);
    for (const [patch, message] of [
      [{ version: "0.5.1" }, "expected routstrd"],
      [{ daemonBundleSha256: digest("other") }, "unreviewed daemon bundle"],
      [{ routes: ["GET /widgets/:id", "DELETE /widgets/:id"] }, "unclassified daemon route(s): DELETE /widgets/:id"],
      [{ routes: ["GET /widgets"] }, "stale or duplicate daemon route"],
    ] as const) {
      const result = run(patch);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain(message);
    }
    const stale = run({}, hashes.replace(digest("proxy"), digest("older proxy")));
    expect(stale.exitCode).not.toBe(0);
    expect(stale.stderr.toString()).toContain("stale proxy.ts");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
