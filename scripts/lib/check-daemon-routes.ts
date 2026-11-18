// Run by check-daemon-routes.sh using Bun in the candidate image, not host source.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [daemon, src, inventoryJson, sourceHashes] = Bun.argv.slice(2);
const inventory = JSON.parse(inventoryJson);
const hash = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");
function check(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(`Daemon route gate: ${message}`);
}
const pkg = JSON.parse(await readFile(join(daemon, "package.json"), "utf8"));
check(pkg.name === "routstrd" && pkg.version === inventory.version,
  `expected routstrd ${inventory.version}, found ${pkg.name} ${pkg.version}; review the inventory before updating the pin`);
const actual = await hash(join(daemon, "dist/daemon/index.js"));
check(actual === inventory.daemonBundleSha256,
  `unreviewed daemon bundle (${actual}); inspect the dispatcher before updating the inventory`);

// In particular, --no-build must not certify an older image with the right
// daemon but an obsolete proxy/authorization policy.
const sources = new Map<string, string>();
for (const line of sourceHashes.split("\n")) {
  const [digest, name] = line.split("  ");
  sources.set(name, digest);
}
for (const file of ["proxy.ts", "daemon-routes.ts"]) {
  check(await hash(join(src, file)) === sources.get(`src/${file}`), `stale ${file}: rebuild this image from the reviewed checkout`);
}
const { DAEMON_ROUTES } = await import(pathToFileURL(join(src, "daemon-routes.ts")).href);
check(Array.isArray(inventory.routes) && inventory.routes.length > 0, "empty route inventory");
const pending = new Set<string>(inventory.routes);
check(pending.size === inventory.routes.length, "duplicate inventory entry");
for (const { method, path, access } of DAEMON_ROUTES) {
  // Compare templates rather than probe a single example (which could match a
  // permissive prefix). The parameter name is not part of the HTTP contract.
  const key = `${method} ${path.replace(/\/:[^/]+/g, "/:id")}`;
  if (access === "inference" && !pending.has(key)) continue; // daemon's reviewed catch-all
  check(["public", "member", "admin", "proxy", "inference", "unsupported"].includes(access), `invalid access for ${key}`);
  check(pending.delete(key), `stale or duplicate daemon route in proxy policy: ${key}`);
}
check(pending.size === 0, `unclassified daemon route(s): ${[...pending].join(", ")}`);
console.log(`Daemon route gate passed: routstrd ${pkg.version}, ${inventory.routes.length} reviewed method/path pairs`);
