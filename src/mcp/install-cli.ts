/**
 * The side-effecting half of the installer. Kept apart from `install.ts` so the
 * logic there can be imported by tests without a filesystem or a subprocess.
 *
 * Run on the target machine, from the folder holding the bundle:
 *   node install.mjs [--dry-run]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  SERVER_NAME,
  ALL_KEYS,
  configPathFor,
  parseEnvFile,
  selectEnv,
  mergeServerEntry,
  buildServerEntry,
  maskValue,
  type DesktopConfig,
} from "./install";

const BUNDLE_NAME = "rad-and-happy-mcp.mjs";
const ENV_NAME = "rad-and-happy.env";

function log(msg = "") {
  console.log(msg);
}

/**
 * Speaks JSON-RPC to the command we just wrote into the config, and counts the
 * tools it lists. This is the only step that can distinguish a working install
 * from a well-formed config pointing at a node that does not exist.
 */
function verify(nodePath: string, bundlePath: string, env: Record<string, string>): Promise<number> {
  return new Promise((resolveP) => {
    const child = spawn(nodePath, [bundlePath], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let stderr = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", () => resolveP(-1));

    const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + "\n");
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "install", version: "1" },
      },
    });
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    }, 500);
    setTimeout(() => {
      child.kill();
      let count = -1;
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 2 && Array.isArray(msg.result?.tools)) count = msg.result.tools.length;
        } catch {
          // A non-JSON line on stdout is itself the failure: something printed
          // a banner into the JSON-RPC channel.
          count = -2;
        }
      }
      if (count < 0 && stderr.trim()) log(`\n  server stderr:\n${stderr.trim().replace(/^/gm, "    ")}`);
      resolveP(count);
    }, 3000);
  });
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const here = dirname(fileURLToPath(import.meta.url));
  const bundlePath = resolve(join(here, BUNDLE_NAME));
  const envPath = resolve(join(here, ENV_NAME));

  log(`Rad & Happy MCP — installing for Claude Desktop`);
  log();

  if (!existsSync(bundlePath)) {
    console.error(`  ${BUNDLE_NAME} is not next to this script (looked in ${here}).`);
    console.error(`  Copy the whole folder across, not just install.mjs.`);
    process.exit(1);
  }

  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) {
    console.error(`  Node ${process.versions.node} is too old — the bundle needs Node 22 or newer.`);
    console.error(`  Install it from https://nodejs.org and run this again.`);
    process.exit(1);
  }

  if (!existsSync(envPath)) {
    const example = join(here, `${ENV_NAME}.example`);
    if (existsSync(example)) copyFileSync(example, envPath);
    console.error(`  ${ENV_NAME} is missing.`);
    console.error(`  ${existsSync(envPath) ? "A blank one has been created" : "Create one"} at:`);
    console.error(`    ${envPath}`);
    console.error(`  Fill in DATABASE_URL and run this again.`);
    process.exit(1);
  }

  const selection = selectEnv(parseEnvFile(readFileSync(envPath, "utf8")));
  if (selection.missingRequired.length > 0) {
    console.error(`  ${ENV_NAME} is missing: ${selection.missingRequired.join(", ")}`);
    console.error(`  The server cannot start without it.`);
    process.exit(1);
  }
  for (const key of ALL_KEYS) {
    const value = selection.env[key];
    log(`  ${value ? "set    " : "not set"}  ${key}${value ? `  ${maskValue(value)}` : ""}`);
  }
  for (const key of selection.ignored) {
    log(`  ignored  ${key}  — not a key this server reads; check the spelling`);
  }
  log();

  const configPath = configPathFor(process.platform, process.env);
  let existing: DesktopConfig | undefined;
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (err) {
      console.error(`  ${configPath} is not valid JSON, so it will not be overwritten.`);
      console.error(`  Fix or move it, then run this again. (${(err as Error).message})`);
      process.exit(1);
    }
  }

  const entry = buildServerEntry(process.execPath, bundlePath, selection.env);
  const { config, replaced, preserved } = mergeServerEntry(existing, entry, SERVER_NAME);

  log(`  config    ${configPath}`);
  log(`  node      ${entry.command}`);
  log(`  bundle    ${bundlePath}`);
  log(`  entry     ${replaced ? "replacing existing" : "adding"} "${SERVER_NAME}"`);
  if (preserved.length > 0) log(`  keeping   ${preserved.join(", ")}`);
  log();

  if (dryRun) {
    log("  --dry-run: nothing written.");
    return;
  }

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  log(`  written.`);

  log(`  verifying the server actually starts...`);
  const tools = await verify(entry.command, bundlePath, selection.env);
  if (tools > 0) {
    log(`  ok — ${tools} tools listed.`);
    log();
    log(`  Quit Claude Desktop completely and reopen it. "${SERVER_NAME}" will be`);
    log(`  under the tools icon in a new chat.`);
  } else {
    console.error(`  the config was written, but the server did not list any tools.`);
    console.error(
      tools === -2
        ? `  something printed to stdout and corrupted the JSON-RPC stream.`
        : `  check DATABASE_URL is reachable from this machine.`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`  failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
