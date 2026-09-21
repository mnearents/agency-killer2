/**
 * Installs the bundled MCP server into Claude Desktop on a machine that does
 * not have this repo.
 *
 * Ships alongside `rad-and-happy-mcp.mjs` in the same folder and is run once:
 *
 *   node install.mjs
 *
 * It reads credentials from `rad-and-happy.env` next to itself, merges an
 * `mcpServers` entry into Claude Desktop's config, and then proves the result
 * by speaking JSON-RPC to the command it just wrote. Writing the file is not
 * evidence the server runs — a wrong node path produces a perfectly written
 * config and a client that silently lists no tools.
 *
 * Everything above `main()` is pure so it can be tested without a filesystem,
 * a Claude Desktop install, or a database.
 */

export interface ServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface DesktopConfig {
  mcpServers?: Record<string, ServerEntry | unknown>;
  [key: string]: unknown;
}

export const SERVER_NAME = "rad-and-happy";

/** Credentials the bundle reads. Only DATABASE_URL is required to boot. */
export const REQUIRED_KEYS = ["DATABASE_URL"] as const;
export const OPTIONAL_KEYS = ["ANALYTICS_DATABASE_URL", "ATTENTIVE_API_KEY"] as const;
export const ALL_KEYS = [...REQUIRED_KEYS, ...OPTIONAL_KEYS] as string[];

/**
 * Where Claude Desktop keeps its config, per platform.
 *
 * `env` is passed rather than read so this is testable on one machine, and so
 * a missing APPDATA on Windows is an error rather than the string "undefined"
 * spliced into a path.
 */
export function configPathFor(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): string {
  const home = env.HOME ?? env.USERPROFILE;
  switch (platform) {
    case "darwin":
      if (!home) throw new Error("HOME is not set, so the config directory cannot be located");
      return `${home}/Library/Application Support/Claude/claude_desktop_config.json`;
    case "win32": {
      const appData = env.APPDATA;
      if (!appData) throw new Error("APPDATA is not set, so the config directory cannot be located");
      return `${appData}\\Claude\\claude_desktop_config.json`;
    }
    case "linux":
      if (!home) throw new Error("HOME is not set, so the config directory cannot be located");
      return `${home}/.config/Claude/claude_desktop_config.json`;
    default:
      throw new Error(`Claude Desktop does not run on ${platform}`);
  }
}

/**
 * Parses a KEY=value file. Deliberately small: no export prefixes, no
 * interpolation, no multi-line values. A connection string containing '=' must
 * survive, so only the first '=' splits.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key !== "") out[key] = value;
  }
  return out;
}

export interface EnvSelection {
  env: Record<string, string>;
  missingRequired: string[];
  missingOptional: string[];
  ignored: string[];
}

/**
 * Picks the keys the server actually reads out of whatever the env file held,
 * and reports the rest in all three directions. An unrecognised key is
 * surfaced rather than dropped: it is usually a typo in a name that matters,
 * and a silently ignored ATTENTIVE_APIKEY reads exactly like a deliberate
 * omission.
 */
export function selectEnv(parsed: Record<string, string>): EnvSelection {
  const env: Record<string, string> = {};
  for (const key of ALL_KEYS) {
    const value = parsed[key];
    if (value !== undefined && value !== "") env[key] = value;
  }
  return {
    env,
    missingRequired: REQUIRED_KEYS.filter((k) => env[k] === undefined),
    missingOptional: OPTIONAL_KEYS.filter((k) => env[k] === undefined),
    ignored: Object.keys(parsed).filter((k) => !ALL_KEYS.includes(k)),
  };
}

export interface MergeResult {
  config: DesktopConfig;
  replaced: boolean;
  preserved: string[];
}

/**
 * Merges the entry into an existing config.
 *
 * Other servers are preserved. A config file on someone's machine is theirs,
 * and an installer that writes `{ mcpServers: { "rad-and-happy": ... } }` over
 * the top removes every other server without anything reporting that it did.
 */
export function mergeServerEntry(
  existing: DesktopConfig | undefined,
  entry: ServerEntry,
  name: string = SERVER_NAME,
): MergeResult {
  const base: DesktopConfig = existing ? { ...existing } : {};
  const servers = { ...(base.mcpServers ?? {}) };
  const replaced = Object.prototype.hasOwnProperty.call(servers, name);
  const preserved = Object.keys(servers).filter((k) => k !== name);
  servers[name] = entry;
  base.mcpServers = servers;
  return { config: base, replaced, preserved };
}

/**
 * Builds the entry.
 *
 * `nodePath` is an absolute path on purpose. Claude Desktop is a GUI app: on
 * macOS it does not inherit the shell's PATH, so a bare "node" resolves against
 * a minimal system PATH and fails for a version manager's node — which is most
 * of them. This is the same reason the repo entry names /usr/local/bin/pnpm.
 */
export function buildServerEntry(
  nodePath: string,
  bundlePath: string,
  env: Record<string, string>,
): ServerEntry {
  if (!isAbsolutePath(nodePath)) {
    throw new Error(
      `node path must be absolute, got "${nodePath}" — Claude Desktop does not inherit your shell PATH`,
    );
  }
  if (!isAbsolutePath(bundlePath)) {
    throw new Error(`bundle path must be absolute, got "${bundlePath}"`);
  }
  return { command: nodePath, args: [bundlePath], env };
}

function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
}

/** Redacts a credential for display. Enough to tell two apart, not enough to use. */
export function maskValue(value: string): string {
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}${"*".repeat(Math.min(value.length - 8, 24))}${value.slice(-4)}`;
}
