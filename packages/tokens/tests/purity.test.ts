/**
 * `normalize.ts` and `validate.ts` must stay pure — no filesystem, no process,
 * no clock. Two independent checks: the source imports nothing that could do
 * I/O, and both modules produce a full result from in-memory objects alone.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeTheme, toCanonical, toRaw } from "../src/normalize.js";
import { validateTheme } from "../src/validate.js";
import { CLEAN_THEME } from "./helpers.js";

const PURE_MODULES = ["normalize.ts", "validate.ts", "refs.ts", "color.ts", "gradient.ts", "report.ts", "config.ts"];

describe("pure modules", () => {
  for (const name of PURE_MODULES) {
    it(`${name} imports no I/O`, () => {
      const source = readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
      expect(imports.filter((i) => i.startsWith("node:"))).toEqual([]);
      expect(source).not.toMatch(/\bprocess\./);
      // Date.now / Math.random would break the byte-determinism guarantee too.
      expect(source).not.toMatch(/\bDate\.now\b|\bnew Date\b|\bMath\.random\b/);
    });
  }

  it("normalize + validate run end to end with no filesystem", () => {
    const theme = normalizeTheme("id", CLEAN_THEME);
    const result = validateTheme(theme);
    expect(result.ok).toBe(true);
    expect(theme.color.light.size).toBe(3);
  });

  it("the naming functions are standalone", () => {
    expect(toCanonical("shadow.light.drop_shadow_md")).toBe("shadow.md");
    expect(toRaw("shadow.md")).toBe("drop_shadow_md");
  });
});
