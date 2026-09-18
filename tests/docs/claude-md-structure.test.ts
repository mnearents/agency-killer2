/**
 * Every file CLAUDE.md's project tree names has to exist.
 *
 * CLAUDE.md listed `src/integrations/attentive.ts # Email/SMS events` for the
 * life of the project. There is no such file — Attentive reporting is scraped
 * by `attentive-agent.ts` and the API client is `attentive-write.ts`. Anyone
 * reading the map went looking for a file that was never written, and the two
 * that exist behave nothing like the one described.
 *
 * CLAUDE.md, "A claim in a comment or docstring is a claim about code that
 * must exist." The project map is the largest such claim in the repo and was
 * the only one nothing checked.
 *
 * Directories are asserted too. The tree carried `domain/video/` for a feature
 * that is deferred and has no code, which is the same claim in a different
 * shape — a reader looking for the video pipeline finds a heading and no
 * explanation.
 *
 * Omissions are fine: the tree is a map, not an inventory, and nothing here
 * requires it to list every file.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const claudeMd = readFileSync(join(root, "CLAUDE.md"), "utf-8");

/**
 * Reconstruct paths from the box-drawing tree.
 *
 * Depth comes from the column the branch marker sits in — four columns per
 * level — so `│   ├── attentive.ts` under `├── integrations/` resolves to
 * `src/integrations/attentive.ts`.
 */
function pathsInTree(block: string): string[] {
  const paths: string[] = [];
  const stack: string[] = [];

  for (const line of block.split("\n")) {
    const marker = line.search(/[├└]──/);
    if (marker === -1) {
      // A bare root line such as `src/` or `app/`.
      const rootDir = line.match(/^([A-Za-z0-9_.-]+\/)\s*$/);
      if (rootDir) {
        stack.length = 0;
        stack.push(rootDir[1]);
      }
      continue;
    }

    const depth = Math.floor(marker / 4) + 1;
    const name = line.slice(marker + 4).trim().split(/\s+#/)[0].trim();
    if (!name) continue;

    stack.length = depth;
    const path = stack.slice(0, depth).join("") + name;
    paths.push(path);
    if (name.endsWith("/")) stack[depth] = name;
  }

  return paths;
}

const treeBlock = claudeMd.split("## Project structure")[1]?.split("```")[1] ?? "";
const claimed = pathsInTree(treeBlock);

describe("CLAUDE.md project structure", () => {
  // If the block moves or the fences change, the sweep below silently checks
  // nothing — an all-skipped suite reporting green. Zero is UNKNOWN.
  it("finds the tree at all", () => {
    expect(treeBlock, "no fenced project-structure block found in CLAUDE.md").not.toBe("");
    expect(claimed.length).toBeGreaterThan(15);
  });

  it("names a file that is definitely there, so the check can fail", () => {
    expect(claimed).toContain("src/db/schema.ts");
  });

  it("names only paths that exist", () => {
    const missing = claimed.filter((f) => !existsSync(join(root, f)));
    expect(missing, `CLAUDE.md names paths that do not exist: ${missing.join(", ")}`).toEqual([]);
  });

  // The tree's only job is to be findable. A directory heading with nothing
  // under it is the shape `domain/video/` had.
  it("names directories that are not empty", () => {
    const emptyDirs = claimed
      .filter((f) => f.endsWith("/") && existsSync(join(root, f)))
      .filter((d) => readdirSync(join(root, d)).length === 0);
    expect(emptyDirs, `CLAUDE.md names empty directories: ${emptyDirs.join(", ")}`).toEqual([]);
  });
});
