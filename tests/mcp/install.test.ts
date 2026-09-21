import { describe, it, expect } from "vitest";
import {
  SERVER_NAME,
  configPathFor,
  parseEnvFile,
  selectEnv,
  mergeServerEntry,
  buildServerEntry,
  maskValue,
} from "@/mcp/install";

describe("configPathFor", () => {
  it("locates the macOS config under Application Support", () => {
    expect(configPathFor("darwin", { HOME: "/Users/t" })).toBe(
      "/Users/t/Library/Application Support/Claude/claude_desktop_config.json",
    );
  });

  it("locates the Windows config under APPDATA", () => {
    expect(configPathFor("win32", { APPDATA: "C:\\Users\\t\\AppData\\Roaming" })).toBe(
      "C:\\Users\\t\\AppData\\Roaming\\Claude\\claude_desktop_config.json",
    );
  });

  it("locates the Linux config under .config", () => {
    expect(configPathFor("linux", { HOME: "/home/t" })).toBe(
      "/home/t/.config/Claude/claude_desktop_config.json",
    );
  });

  // Splicing "undefined" into a path writes a real file somewhere nobody looks,
  // and the install then reports success against a config Claude never reads.
  it("fails rather than building a path from a missing HOME", () => {
    expect(() => configPathFor("darwin", {})).toThrow(/HOME/);
  });

  it("fails rather than building a path from a missing APPDATA", () => {
    expect(() => configPathFor("win32", { HOME: "/home/t" })).toThrow(/APPDATA/);
  });

  it("rejects a platform Claude Desktop does not run on", () => {
    expect(() => configPathFor("aix", { HOME: "/home/t" })).toThrow(/aix/);
  });
});

describe("parseEnvFile", () => {
  it("reads a plain key and value", () => {
    expect(parseEnvFile("DATABASE_URL=postgres://x")).toEqual({ DATABASE_URL: "postgres://x" });
  });

  // Connection strings carry '=' in their query parameters. Splitting on every
  // '=' truncates the URL into something that still parses and cannot connect.
  it("splits on the first equals only, so a connection string survives", () => {
    expect(parseEnvFile("DATABASE_URL=postgres://h/db?sslmode=require&x=1")).toEqual({
      DATABASE_URL: "postgres://h/db?sslmode=require&x=1",
    });
  });

  it("ignores comments and blank lines", () => {
    expect(parseEnvFile("# a comment\n\nA=1\n   \n# another\nB=2")).toEqual({ A: "1", B: "2" });
  });

  it("strips surrounding quotes", () => {
    expect(parseEnvFile(`A="one"\nB='two'`)).toEqual({ A: "one", B: "two" });
  });

  it("keeps quotes that are not a matched surrounding pair", () => {
    expect(parseEnvFile(`A="unclosed`)).toEqual({ A: '"unclosed' });
  });

  it("handles CRLF line endings, since the file may be edited on Windows", () => {
    expect(parseEnvFile("A=1\r\nB=2\r\n")).toEqual({ A: "1", B: "2" });
  });

  it("ignores a line with no equals rather than inventing an empty key", () => {
    expect(parseEnvFile("junk\nA=1")).toEqual({ A: "1" });
  });
});

describe("selectEnv", () => {
  it("reports a missing DATABASE_URL as a missing requirement", () => {
    expect(selectEnv({}).missingRequired).toEqual(["DATABASE_URL"]);
  });

  it("treats an empty value as absent, because a blank template line is not a setting", () => {
    const selection = selectEnv({ DATABASE_URL: "postgres://x", ANALYTICS_DATABASE_URL: "" });
    expect(selection.env.ANALYTICS_DATABASE_URL).toBeUndefined();
    expect(selection.missingOptional).toContain("ANALYTICS_DATABASE_URL");
  });

  it("separates the optional keys from the required ones", () => {
    const selection = selectEnv({ DATABASE_URL: "postgres://x" });
    expect(selection.missingRequired).toEqual([]);
    expect(selection.missingOptional).toEqual(["ANALYTICS_DATABASE_URL", "ATTENTIVE_API_KEY"]);
  });

  // A misspelled key is indistinguishable from a deliberate omission unless the
  // installer says it saw something it did not recognise.
  it("reports an unrecognised key instead of dropping it", () => {
    expect(selectEnv({ DATABASE_URL: "x", ATTENTIVE_APIKEY: "y" }).ignored).toEqual([
      "ATTENTIVE_APIKEY",
    ]);
  });

  it("does not pass an unrecognised key through to the server environment", () => {
    expect(selectEnv({ DATABASE_URL: "x", ATTENTIVE_APIKEY: "y" }).env).toEqual({
      DATABASE_URL: "x",
    });
  });
});

describe("mergeServerEntry", () => {
  const entry = { command: "/usr/bin/node", args: ["/opt/mcp.mjs"], env: { DATABASE_URL: "x" } };

  it("adds the server to an empty config", () => {
    const result = mergeServerEntry(undefined, entry);
    expect(result.config.mcpServers).toEqual({ [SERVER_NAME]: entry });
    expect(result.replaced).toBe(false);
  });

  // An installer that writes its own object over mcpServers deletes every other
  // server, and nothing in Claude Desktop reports that they went missing.
  it("preserves other servers already in the config", () => {
    const existing = { mcpServers: { other: { command: "x", args: [], env: {} } } };
    const result = mergeServerEntry(existing, entry);
    expect(Object.keys(result.config.mcpServers!).sort()).toEqual(["other", SERVER_NAME]);
    expect(result.preserved).toEqual(["other"]);
  });

  it("preserves unrelated top-level settings", () => {
    const result = mergeServerEntry({ globalShortcut: "Cmd+X" }, entry);
    expect(result.config.globalShortcut).toBe("Cmd+X");
  });

  it("reports that it replaced an existing entry rather than replacing it silently", () => {
    const existing = { mcpServers: { [SERVER_NAME]: { command: "old", args: [], env: {} } } };
    const result = mergeServerEntry(existing, entry);
    expect(result.replaced).toBe(true);
    expect(result.config.mcpServers![SERVER_NAME]).toEqual(entry);
  });

  it("does not mutate the config it was given", () => {
    const existing = { mcpServers: { other: { command: "x", args: [], env: {} } } };
    mergeServerEntry(existing, entry);
    expect(Object.keys(existing.mcpServers)).toEqual(["other"]);
  });
});

describe("buildServerEntry", () => {
  it("records the node path and the bundle path", () => {
    expect(buildServerEntry("/usr/local/bin/node", "/opt/rad/mcp.mjs", { DATABASE_URL: "x" })).toEqual({
      command: "/usr/local/bin/node",
      args: ["/opt/rad/mcp.mjs"],
      env: { DATABASE_URL: "x" },
    });
  });

  // Claude Desktop is a GUI app and does not inherit the shell's PATH. A bare
  // "node" resolves against a minimal system PATH, which is where a version
  // manager's node is not — the config looks right and the server never starts.
  it("rejects a bare command name, which would not resolve from a GUI app", () => {
    expect(() => buildServerEntry("node", "/opt/rad/mcp.mjs", {})).toThrow(/absolute/);
  });

  it("rejects a relative bundle path", () => {
    expect(() => buildServerEntry("/usr/bin/node", "./mcp.mjs", {})).toThrow(/absolute/);
  });

  it("accepts a Windows drive path", () => {
    expect(buildServerEntry("C:\\Program Files\\nodejs\\node.exe", "C:\\rad\\mcp.mjs", {}).args).toEqual([
      "C:\\rad\\mcp.mjs",
    ]);
  });
});

describe("maskValue", () => {
  it("shows enough of a credential to tell two apart", () => {
    expect(maskValue("postgres://user:pw@host/db")).toMatch(/^post.*\/db$/);
  });

  it("does not contain the middle of the secret", () => {
    expect(maskValue("postgres://user:hunter2@host/db")).not.toContain("hunter2");
  });

  it("reveals nothing at all from a short value", () => {
    expect(maskValue("abc123")).toBe("******");
  });
});
