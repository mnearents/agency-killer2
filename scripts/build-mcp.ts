/**
 * Bundles the MCP server into a folder that installs on a machine without this
 * repo: one self-contained ESM file per entry point, plus an env template and
 * a README. The target machine needs Node 22 and nothing else — no clone, no
 * pnpm install, no node_modules, no toolchain.
 *
 * That is possible because the MCP import graph is pure TypeScript over three
 * pure-JS packages. Nothing in it compiles per-platform, so one bundle built
 * here runs on macOS, Windows and Linux alike.
 *
 * The build fails if a module that resolves paths at runtime enters the graph.
 * Bundled, such a module's `import.meta.url` points at the bundle and its
 * `process.cwd()` fallback points wherever Claude Desktop started the process
 * — neither is the repo. It would work here and throw there, and the failure
 * would surface as a client that lists no tools and says nothing.
 */

import { build } from "esbuild";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const OUT_DIR = join(root, "dist/mcp");

export const ENTRIES: BundleEntry[] = [
  { in: "src/mcp/index.ts", out: "rad-and-happy-mcp.mjs" },
  { in: "src/mcp/install-cli.ts", out: "install.mjs" },
];

export const DISK_READERS = ["src/domain/voice/loader.ts", "src/db/schema-gate.ts"];

export interface BundleEntry {
  in: string;
  out: string;
}

export interface BuiltEntry extends BundleEntry {
  inputs: string[];
  violations: string[];
}

/**
 * The guard, separated from the build so it can be tested against a graph that
 * does contain a disk reader. Testing it only against the real bundle would
 * assert that today's import graph is clean, not that the check works — and a
 * check that cannot fail is the thing this repo treats as worse than none.
 */
export function findDiskReaderViolations(
  inputs: string[],
  diskReaders: string[] = DISK_READERS,
): string[] {
  return diskReaders.filter((f) => inputs.includes(f));
}

const ENV_EXAMPLE = `# Rad & Happy MCP — credentials for this machine.
# Fill in DATABASE_URL, then run:  node install.mjs

# Required. Railway's DATABASE_PUBLIC_URL — the internal .railway.internal host
# only resolves from inside Railway and will hang from a laptop.
DATABASE_URL=

# Optional. The read-only claude_readonly role, used only by the \`query\` tool.
# Leave blank and every other tool still works; \`query\` reports itself
# unavailable rather than falling back to the line above.
ANALYTICS_DATABASE_URL=

# Optional. Only needed if this machine should be able to push segments to
# Attentive. Leave blank for a read-only install.
ATTENTIVE_API_KEY=
`;

const README = `# Rad & Happy MCP — install on this machine

Gives Claude Desktop read access to the Rad & Happy warehouse.

## What you need

Node 22 or newer. Check with \`node --version\`; install from https://nodejs.org
if it is missing or older.

## Install

1. Keep this whole folder together — \`install.mjs\` needs the bundle beside it.
2. Open \`rad-and-happy.env\` and paste in \`DATABASE_URL\`.
3. In a terminal, from this folder:

       node install.mjs

   It writes the Claude Desktop config, then starts the server and counts the
   tools it lists. "ok — N tools listed" means it genuinely works; a written
   config on its own does not.

4. Quit Claude Desktop **completely** and reopen it.

Run \`node install.mjs --dry-run\` first to see what it would change.

## Updating

Replace the two \`.mjs\` files with newer ones and restart Claude Desktop. The
config keeps pointing at the same paths, so there is nothing to re-run unless
the folder moves or a credential changes.

## If Claude Desktop shows no tools

- The installer records the absolute path of the \`node\` that ran it. If that
  node came from a version manager and has since been removed, re-run the
  installer with a node that will stay put.
- Moving this folder breaks the config, because the path is absolute. Re-run
  \`node install.mjs\` after moving it.
- \`DATABASE_URL\` must be Railway's public URL. The internal host does not
  resolve off-platform.
`;

export async function buildMcpBundle({ outDir = OUT_DIR, clean = true } = {}) {
  if (clean) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const built: BuiltEntry[] = [];
  for (const entry of ENTRIES) {
    const result = await build({
      entryPoints: [join(root, entry.in)],
      outfile: join(outDir, entry.out),
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      tsconfig: join(root, "tsconfig.json"),
      metafile: true,
      // postgres reaches for this lazily behind feature detection; it is a
      // Cloudflare Workers built-in and is not needed for TCP + TLS.
      external: ["cloudflare:sockets"],
      banner: {
        // drizzle-orm and postgres ship CJS interop that expects `require`.
        js: [
          "import { createRequire as __createRequire } from 'node:module';",
          "const require = __createRequire(import.meta.url);",
        ].join("\n"),
      },
    });
    const inputs = Object.keys(result.metafile.inputs).map((p) => relative(root, join(root, p)));
    built.push({ ...entry, inputs, violations: findDiskReaderViolations(inputs) });
  }

  writeFileSync(join(outDir, "rad-and-happy.env.example"), ENV_EXAMPLE, "utf8");
  writeFileSync(join(outDir, "README.md"), README, "utf8");

  return { outDir, built, violations: built.flatMap((b) => b.violations.map((v) => `${b.out}: ${v}`)) };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { outDir, built, violations } = await buildMcpBundle();
  if (violations.length > 0) {
    console.error("[build-mcp] modules that read from disk at runtime are in the bundle:");
    for (const v of violations) console.error(`  ${v}`);
    console.error("[build-mcp] they resolve paths relative to src/ and will throw once bundled.");
    process.exit(1);
  }
  for (const b of built) console.error(`[build-mcp] ${b.out} — ${b.inputs.length} modules`);
  console.error(`[build-mcp] ${outDir}`);
}
