/**
 * The portable bundle: the artifact that gets copied to a machine without this
 * repo. What matters is not that esbuild produced a file but that the file
 * runs — so this builds it and speaks JSON-RPC to it.
 *
 * No database is reached. The server connects its transport and lists its
 * tools before any query runs, so a deliberately unreachable DATABASE_URL
 * exercises the whole startup path without touching the network.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isBuiltin } from "node:module";
import { buildMcpBundle, findDiskReaderViolations, ENTRIES } from "../../scripts/build-mcp";

/** Unroutable by definition (RFC 5737), so a stray connection cannot succeed. */
const UNREACHABLE_DB = "postgres://nobody:nobody@192.0.2.1:5432/none";

describe("findDiskReaderViolations", () => {
  // The guard has to be shown failing. Run only against the real graph it
  // would report clean whether it worked or was hardcoded to return [].
  it("reports a module that reads from disk at runtime", () => {
    expect(findDiskReaderViolations(["src/mcp/index.ts", "src/domain/voice/loader.ts"])).toEqual([
      "src/domain/voice/loader.ts",
    ]);
  });

  it("reports every such module, not just the first", () => {
    expect(
      findDiskReaderViolations(["src/db/schema-gate.ts", "src/domain/voice/loader.ts"]),
    ).toHaveLength(2);
  });

  it("passes a graph with none of them", () => {
    expect(findDiskReaderViolations(["src/mcp/index.ts", "src/db/client.ts"])).toEqual([]);
  });
});

describe("the built bundle", () => {
  let outDir: string;
  let built: Awaited<ReturnType<typeof buildMcpBundle>>;

  beforeAll(async () => {
    outDir = mkdtempSync(join(tmpdir(), "mcp-bundle-"));
    built = await buildMcpBundle({ outDir });
  }, 120_000);

  afterAll(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it("emits every declared entry point", () => {
    for (const entry of ENTRIES) {
      expect(existsSync(join(outDir, entry.out))).toBe(true);
    }
  });

  // The whole point of the artifact: one file that runs with no node_modules
  // beside it. Node builtins are resolved by the runtime and are expected; a
  // package name surviving into the output means it was left for an install
  // step that is not going to happen on the other machine.
  it("resolves every package into the file, leaving only Node builtins imported", () => {
    const source = readFileSync(join(outDir, "rad-and-happy-mcp.mjs"), "utf8");
    const unresolved = [...source.matchAll(/^import\s+[^;]*?from\s*["']([^"']+)["']/gm)]
      .map((m) => m[1])
      .filter((spec) => !isBuiltin(spec));
    expect(unresolved).toEqual([]);
  });

  it("pulls in no module that resolves paths at runtime", () => {
    expect(built.violations).toEqual([]);
  });

  it("ships the env template and the README the installer refers to", () => {
    expect(existsSync(join(outDir, "rad-and-happy.env.example"))).toBe(true);
    expect(existsSync(join(outDir, "README.md"))).toBe(true);
  });

  it("names all three environment variables in the env template", () => {
    const template = readFileSync(join(outDir, "rad-and-happy.env.example"), "utf8");
    for (const key of ["DATABASE_URL", "ANALYTICS_DATABASE_URL", "ATTENTIVE_API_KEY"]) {
      expect(template).toContain(key);
    }
  });

  describe("run as Claude Desktop runs it", () => {
    let result: { stdout: string; stderr: string };

    beforeAll(async () => {
      result = await handshake(join(outDir, "rad-and-happy-mcp.mjs"));
    }, 60_000);

    it("completes the initialize handshake", () => {
      const init = messages(result.stdout).find((m) => m.id === 1);
      expect(init?.result?.serverInfo?.name).toBe("rad-and-happy");
    });

    it("lists its tools", () => {
      const list = messages(result.stdout).find((m) => m.id === 2);
      expect(list?.result?.tools?.length).toBeGreaterThan(0);
    });

    // stdout is the JSON-RPC channel. One stray line of logging corrupts the
    // stream, and the client reports only that the server failed to start —
    // the same failure the `--silent` flag exists to prevent in the repo entry.
    it("writes nothing but JSON-RPC to stdout", () => {
      for (const line of result.stdout.split("\n").filter((l) => l.trim() !== "")) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });

    it("reports the missing optional credentials on stderr", () => {
      expect(result.stderr).toContain("ANALYTICS_DATABASE_URL");
    });
  });
});

interface RpcMessage {
  id?: number;
  result?: {
    serverInfo?: { name?: string };
    tools?: unknown[];
  };
}

function messages(stdout: string): RpcMessage[] {
  return stdout
    .split("\n")
    .filter((l) => l.trim() !== "")
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as RpcMessage];
      } catch {
        return [];
      }
    });
}

function handshake(bundlePath: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [bundlePath], {
      env: { ...process.env, DATABASE_URL: UNREACHABLE_DB, ANALYTICS_DATABASE_URL: "", ATTENTIVE_API_KEY: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", rejectPromise);

    const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + "\n");
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    }, 400);
    setTimeout(() => {
      child.kill();
      resolvePromise({ stdout, stderr });
    }, 2500);
  });
}
