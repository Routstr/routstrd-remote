import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Run the real startup script without root, Cloudron, a daemon, or mint access.
// Remap only platform paths; stub external commands, not the shell control flow.
function sandbox(test: (fixture: ReturnType<typeof createSandbox>) => void) {
  const fixture = createSandbox();
  try {
    test(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function createSandbox() {
  const root = mkdtempSync(join(tmpdir(), "cloudron-start-test-"));
  const data = join(root, "data");
  const bin = join(root, "bin");
  const trace = join(root, "trace");
  mkdirSync(bin);
  const command = (name: string, body: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/bash\nset -eu\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  command("chown", ":");
  command("gosu", 'shift; exec "$@"');
  command("bun", 'echo configure >> "$TRACE"');
  command("routstrd", `
    echo "$1" >> "$TRACE"
    case "$1" in
      onboard)
        if [[ "$MODE" == init-failure ]]; then
          echo "Permission denied initializing wallet" >&2
          exit 23
        fi
        mkdir -p "$ROUTSTRD_DIR/wallet"
        printf '{}\\n' > "$ROUTSTRD_DIR/wallet/config.json"
        if [[ "$MODE" == network-failure ]]; then
          echo "Mint unavailable: connection refused" >&2
          exit 1
        fi
        if [[ "$MODE" == interrupted ]]; then
          kill -TERM "$$"
        fi
        ;;
      stop)
        if [[ "$MODE" == stop-failure ]]; then
          echo "Wallet daemon still holds lock" >&2
          exit 24
        fi
        ;;
      *) exit 99 ;;
    esac
  `);
  const supervisor = command("supervisord", 'echo supervisor >> "$TRACE"');
  const script = join(root, "start.sh");
  writeFileSync(script, readFileSync(new URL("./start.sh", import.meta.url), "utf8")
    .replaceAll("/app/data", data)
    .replaceAll("/usr/bin/supervisord", supervisor));

  return {
    root,
    wallet: join(data, "routstrd/wallet/config.json"),
    initialized: join(data, ".initialized"),
    run(mode = "success") {
      writeFileSync(trace, "");
      const result = Bun.spawnSync(["bash", script], {
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          TRACE: trace,
          MODE: mode,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        code: result.exitCode,
        stderr: result.stderr.toString(),
        calls: readFileSync(trace, "utf8").trim().split("\n"),
      };
    },
  };
}

describe("Cloudron first-boot failure handling", () => {
  it("onboards and stops the daemon before configuration and supervisord", () => sandbox((f) => {
    const result = f.run();
    expect(result.code).toBe(0);
    expect(result.calls).toEqual(["onboard", "stop", "configure", "supervisor"]);
    expect(existsSync(f.wallet)).toBe(true);
  }));

  it("fails closed on an initialization error and retries onboarding next boot", () => sandbox((f) => {
    const result = f.run("init-failure");
    expect(result.code).toBe(23);
    expect(result.stderr).toContain("Permission denied");
    expect(result.calls).toEqual(["onboard"]);
    expect(existsSync(f.wallet)).toBe(false);
    expect(existsSync(f.initialized)).toBe(false);
    expect(f.run().calls).toEqual(["onboard", "stop", "configure", "supervisor"]);
  }));

  it("does not launch supervisord when onboarding is interrupted after wallet creation", () => sandbox((f) => {
    const result = f.run("interrupted");
    expect(result.code).toBe(143);
    expect(result.calls).toEqual(["onboard"]);
    expect(existsSync(f.wallet)).toBe(true);
    expect(existsSync(f.initialized)).toBe(false);
    // A completed wallet config survives interruption; restarting skips onboarding.
    const walletBefore = readFileSync(f.wallet, "utf8");
    const retry = f.run();
    expect(retry.code).toBe(0);
    expect(retry.calls).toEqual(["configure", "supervisor"]);
    expect(readFileSync(f.wallet, "utf8")).toBe(walletBefore);
  }));

  it("fails closed on unavailable mint networking, preserving the wallet for restart", () => sandbox((f) => {
    // Model onboard's nonzero result after it has written wallet/config.json.
    const result = f.run("network-failure");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Mint unavailable");
    expect(result.calls).toEqual(["onboard"]);
    expect(existsSync(f.wallet)).toBe(true);
    expect(existsSync(f.initialized)).toBe(false);
    const walletBefore = readFileSync(f.wallet, "utf8");
    const retry = f.run("network-failure");
    expect(retry.code).toBe(0);
    expect(retry.calls).toEqual(["configure", "supervisor"]);
    expect(readFileSync(f.wallet, "utf8")).toBe(walletBefore);
  }));

  it("does not hand off to supervisord if stopping the onboarding daemon fails", () => sandbox((f) => {
    const result = f.run("stop-failure");
    expect(result.code).toBe(24);
    expect(result.stderr).toContain("still holds lock");
    expect(result.calls).toEqual(["onboard", "stop"]);
    expect(existsSync(f.initialized)).toBe(false);
  }));
});
