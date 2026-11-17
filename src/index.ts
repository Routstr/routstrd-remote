#!/usr/bin/env bun
import { program } from "commander";
import { loadConfig, validateConfig } from "./config";
import { AuthProxy } from "./proxy";

program
  .name("routstrd-auth")
  .description("Auth proxy for routstrd — validates Bearer tokens or NIP-98 Nostr auth and forwards requests")
  .version("0.1.0");

/**
 * A malformed environment variable should read as a one-line configuration
 * error, not as a stack trace from somewhere inside the proxy.
 */
function loadConfigOrExit(): ReturnType<typeof loadConfig> {
  try {
    return loadConfig();
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

program
  .command("start")
  .description("Start the auth proxy")
  .option("-p, --port <port>", "Public port to listen on", (v) => Number.parseInt(v, 10))
  .option("-h, --host <host>", "Host to bind")
  .option("-u, --upstream <url>", "Upstream routstrd URL")
  .option("-d, --db-path <path>", "Path to shared SQLite DB")
  .action((opts) => {
    const cfg = loadConfigOrExit();
    if (opts.port) cfg.port = opts.port;
    if (opts.host) cfg.host = opts.host;
    if (opts.upstream) cfg.upstream = opts.upstream;
    if (opts.dbPath) cfg.dbPath = opts.dbPath;

    const err = validateConfig(cfg);
    if (err) {
      console.error(`Error: ${err}`);
      process.exit(1);
    }

    const proxy = new AuthProxy(cfg);
    proxy.serve();
  });

program
  .command("validate")
  .description("Validate configuration and check DB connectivity")
  .option("-d, --db-path <path>", "Path to shared SQLite DB")
  .action((opts) => {
    const cfg = loadConfigOrExit();
    if (opts.dbPath) cfg.dbPath = opts.dbPath;

    console.log("Configuration:");
    console.log(`  Port:     ${cfg.port}`);
    console.log(`  Host:     ${cfg.host}`);
    console.log(`  Upstream: ${cfg.upstream}`);
    console.log(`  DB path:  ${cfg.dbPath}`);
    console.log(`  Bootstrap admin npubs/pubkeys from env: ${cfg.adminPubkeys.length}`);
    console.log(`  Model allowlist: ${cfg.modelAllowlistEnabled ? "enabled" : "disabled"}`);
    console.log(`  NIP-98 URL binding: ${cfg.publicUrl ?? "(request headers)"}`);

    const err = validateConfig(cfg);
    if (err) {
      console.error(`\n❌ ${err}`);
      process.exit(1);
    }

    // Try opening the DB to verify schema exists.
    const proxy = new AuthProxy(cfg);
    const npubCount = proxy["store"].countNpubs();
    const adminCount = proxy["store"].countNpubs("admin");
    const userCount = proxy["store"].countNpubs("user");
    proxy.close();

    console.log(`\n✅ DB accessible. ${npubCount} npub(s) registered (${adminCount} admin, ${userCount} user).`);
  });

program.parse();
