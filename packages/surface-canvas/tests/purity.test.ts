/**
 * The architectural invariant, enforced.
 *
 * Lint runs on Frame IR, never on Figma nodes. That is what lets the same engine
 * run in the plugin and in CI, and lets a rule change be replayed across the
 * corpus. A test in here failing means the seam has been crossed, and the fix is
 * to move the Figma call into reconcile.ts / fix.ts and pass data instead.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PURE_DIRS = ["src/health", "src/rules", "src/match", "src/api"];

/** `src/ir/schema.ts` is pure too — the extractor was built that way on purpose. */
const PURE_FILES = [
  "src/ir/schema.ts",
  "src/ir/signature.ts",
  "src/ir/index.ts",
  "src/assets.ts",
  "src/ui/state.ts",
  "src/ui/rows.ts",
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (path.endsWith(".ts") || path.endsWith(".tsx")) out.push(path);
  }
  return out;
}

const pureFiles = [...PURE_DIRS.flatMap(walk), ...PURE_FILES];

describe("the pure half of the package", () => {
  it("has files to check", () => {
    expect(pureFiles.length).toBeGreaterThan(15);
  });

  it("never imports the Figma typings", () => {
    for (const file of pureFiles) {
      const source = readFileSync(file, "utf8");
      expect(source, `${file} imports @figma/plugin-typings`).not.toMatch(
        /from\s+["']@figma\//,
      );
    }
  });

  it("never touches the figma global", () => {
    for (const file of pureFiles) {
      const source = stripComments(readFileSync(file, "utf8"));
      expect(source, `${file} references the figma global`).not.toMatch(/\bfigma\s*\./);
      expect(source, `${file} references __html__`).not.toMatch(/__html__/);
    }
  });

  it("never imports a Figma-aware module", () => {
    // reconcile.ts, fix.ts, heatmap.ts, traverse.ts, export.ts, main.ts talk to
    // Figma. Nothing pure may reach for them.
    const forbidden = ["reconcile.js", "fix.js", "heatmap.js", "traverse", "export.js", "main.js"];
    for (const file of pureFiles) {
      if (file.startsWith("src/ui/")) continue; // the panel imports its own main.tsx for send()
      const source = readFileSync(file, "utf8");
      for (const module of forbidden) {
        expect(source, `${file} imports ${module}`).not.toMatch(
          new RegExp(`from\\s+["'][^"']*/${module.replace(".", "\\.")}["']`),
        );
      }
    }
  });

  it("never uses a Figma-only global from the sandbox", () => {
    for (const file of pureFiles) {
      const source = stripComments(readFileSync(file, "utf8"));
      expect(source, `${file} uses SceneNode`).not.toMatch(/\bSceneNode\b/);
      expect(source, `${file} uses VariableAlias`).not.toMatch(/\bVariableAlias\b/);
    }
  });
});

/** Comments mention Figma constantly and should not trip the checks. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
