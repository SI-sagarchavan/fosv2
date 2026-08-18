/**
 * `validate.ts` and every tree op must stay pure — no filesystem, no process,
 * no clock. Checked two ways: the sources import nothing that could do I/O, and
 * both run end to end against in-memory objects.
 *
 * The type-level assertions at the bottom are checked by `pnpm typecheck`, not
 * at runtime — that is the point of them.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TypeToken } from "@fanos/tokens";
import { validate } from "../src/validate.js";
import { setProp, wrapIn } from "../src/ops.js";
import { flatten, reify } from "../src/flat.js";
import { analyze } from "../src/metrics.js";
import type { Resp, Val } from "../src/values.js";
import { card, registry } from "./helpers.js";

const PURE_MODULES = [
  "validate.ts",
  "ops.ts",
  "sha1.ts",
  "subtree-signature.ts",
  "collapse.ts",
  "flat.ts",
  "metrics.ts",
  "walk.ts",
  "values.ts",
  "field.ts",
  "suggest.ts",
  "universal.ts",
  "version.ts",
  "nodes/index.ts",
  "nodes/structural.ts",
  "nodes/leaves.ts",
  "emit/types.ts",
  "emit/json-schema.ts",
  "emit/docs.ts",
];

describe("pure modules", () => {
  for (const name of PURE_MODULES) {
    it(`${name} imports no I/O`, () => {
      const source = readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
      expect(imports.filter((i) => i.startsWith("node:"))).toEqual([]);
      expect(source).not.toMatch(/\bprocess\./);
      expect(source).not.toMatch(/\bDate\.now\b|\bnew Date\b|\bMath\.random\b/);
    });
  }

  it("validate runs against an in-memory tree", () => {
    const tree = { schemaVersion: "1.0.0", nodes: [{ id: "a", parent: null, idx: 0, type: "Box", src: "1:1", props: {} }] };
    expect(validate(tree, { registry: registry() }).ok).toBe(true);
  });

  it("tree ops and analyze need nothing but the tree", () => {
    const tree = flatten(reify(card()));
    expect(analyze(setProp(wrapIn(tree, "stat_matches_label", "Box"), "stats", "gap", "space.6")).nodeCount).toBe(23);
  });
});

// ---------------------------------------------------------------------------
// Type-level guarantees. These fail `tsc --noEmit`, not vitest.
// ---------------------------------------------------------------------------

type Assert<T extends true> = T;

/**
 * `Resp<TypeToken>` must be a TYPE ERROR, not merely a runtime one. Type tokens
 * already resolve per breakpoint inside @fanos/tokens, so wrapping one creates
 * two competing responsive systems for a single value.
 */
type _TypeTokenIsNotResponsive = Assert<[Resp<TypeToken>] extends [never] ? true : false>;

/** Everything else stays responsive, including mixed token/raw wrappers. */
type _ValStaysResponsive = Assert<
  { base: "space.4"; md: { raw: 12; _unbound: true } } extends Resp<Val<number>> ? true : false
>;

type _SurfaceStaysResponsive = Assert<
  { base: "surface.card_player" } extends Resp<`surface.${string}`> ? true : false
>;

describe("type-level guarantees", () => {
  it("are enforced by typecheck, and this keeps the imports live", () => {
    const proof: [_TypeTokenIsNotResponsive, _ValStaysResponsive, _SurfaceStaysResponsive] = [true, true, true];
    expect(proof).toEqual([true, true, true]);
  });
});
