import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readdirSync } from "node:fs";

const root = process.cwd();
/** The buildCommand only — comments in these files mention the command too. */
function buildCommandOf(file: string): string {
  const text = readFileSync(join(root, file), "utf-8");
  const match = text.match(/^buildCommand\s*=\s*"(.*)"\s*$/m);
  if (!match) throw new Error(`No buildCommand in ${file}`);
  return match[1];
}

const web = buildCommandOf("railway.toml");
const worker = buildCommandOf("worker.railway.toml");

/** Every source file that pulls in Playwright. */
function playwrightImporters(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && readFileSync(path, "utf-8").includes('from "playwright"')) {
        found.push(path.slice(root.length + 1));
      }
    }
  };
  walk(join(root, "src"));
  return found;
}

describe("the Railway build commands", () => {
  // The web build gates migrations through preDeployCommand, so a browser
  // download there delays every schema change — and `playwright install
  // --with-deps` runs apt-get, which failed a build outright when Ubuntu's
  // mirror was mid-sync.
  it("does not install a browser for the web service", () => {
    expect(web).not.toMatch(/playwright install/);
  });

  it("still installs one for the worker, which scrapes Attentive", () => {
    expect(worker).toMatch(/playwright install --with-deps chromium/);
  });

  it("still builds the Next app", () => {
    expect(web).toMatch(/pnpm build/);
  });

  // The reason web needs no browser is that nothing it serves uses one. If a
  // third importer appears, this goes red rather than the page failing in
  // production with a missing executable.
  it("has no Playwright importer beyond the worker's scraper and the uncalled renderer", () => {
    expect(playwrightImporters().sort()).toEqual([
      "src/domain/email/renderer.ts",
      "src/integrations/attentive-agent.ts",
    ]);
  });

  // Named because it is the load-bearing fact: the renderer imports a browser
  // and nothing imports the renderer, so removing the web install is safe.
  it("confirms the email renderer still has no callers", () => {
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name) && !path.endsWith("renderer.ts")) {
          if (readFileSync(path, "utf-8").includes("email/renderer")) importers.push(path);
        }
      }
    };
    for (const dir of ["src", "app"]) walk(join(root, dir));
    expect(importers).toEqual([]);
  });
});
