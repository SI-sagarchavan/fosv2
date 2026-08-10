/**
 * Every fixture in `fixtures/` must parse and validate clean.
 *
 * Derived from the directory, not a hand-written list, so a newly generated
 * tree is covered the moment it lands — the point of a fixture is to be a
 * known-good example, and a broken one is worse than none.
 */

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flatTreeSchema, reify, rootOf } from "../src/flat.js";
import { validate } from "../src/validate.js";
import { registry } from "./helpers.js";

const DIR = new URL("../fixtures/", import.meta.url).pathname;
const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

describe("fixtures", () => {
  it("has some", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    describe(file, () => {
      const tree = () => flatTreeSchema.parse(JSON.parse(readFileSync(DIR + file, "utf8")));

      it("parses against the wire schema", () => {
        expect(() => tree()).not.toThrow();
      });

      it("reifies into a single-rooted tree", () => {
        const t = tree();
        expect(() => reify(t)).not.toThrow();
        expect(rootOf(t)).toBeDefined();
      });

      it("validates with zero errors and zero warnings", () => {
        const result = validate(tree(), { registry: registry() });
        // Print the codes rather than a bare `false` — a failure here should say
        // which rule fired without a second run.
        expect(result.errors.map((i) => `${i.code} ${i.nodeId ?? ""}`)).toEqual([]);
        expect(result.warnings.map((i) => `${i.code} ${i.nodeId ?? ""}`)).toEqual([]);
      });

      it("gives every node a Figma src, and never reuses one", () => {
        const nodes = tree().nodes;
        expect(nodes.filter((n) => !n.src).map((n) => n.id)).toEqual([]);
        // `src` is the anchor the pixel-diff repair loop maps a region back to,
        // so a duplicate makes a diff ambiguous. A synthetic grouping node that
        // has no Figma counterpart of its own must carry a `synthetic:` id.
        const seen = new Map<string, string>();
        const dupes: string[] = [];
        for (const n of nodes) {
          const prev = seen.get(n.src!);
          if (prev) dupes.push(`${n.src} used by ${prev} and ${n.id}`);
          else seen.set(n.src!, n.id);
        }
        expect(dupes).toEqual([]);
      });
    });
  }
});

/**
 * The fixture card leans on deliberate overflow: its row is 235px tall inside a
 * 227px shell, so the two cards bleed 4px past the top and bottom and get cut.
 * Drop the clip, or let the cards hug their content instead of taking the full
 * 235, and a band of shell grey appears under them.
 */
describe("fixture-card overflow geometry", () => {
  const tree = () =>
    flatTreeSchema.parse(
      JSON.parse(readFileSync(new URL("../fixtures/fixture-card.json", import.meta.url), "utf8")),
    );
  const h = (id: string) => {
    const n = tree().nodes.find((x) => x.id === id)!;
    return (n.props.size as { h?: { raw?: number } } | undefined)?.h?.raw;
  };
  const clips = (id: string) => tree().nodes.find((x) => x.id === id)!.props.clip === true;

  const sizeOf = (id: string, axis: "w" | "h") =>
    (tree().nodes.find((x) => x.id === id)!.props.size as Record<string, unknown> | undefined)?.[
      axis
    ];

  it("keeps the frames that clip at their IR heights", () => {
    expect(h("shell")).toBe(227);
    expect(h("fixtures_frame")).toBe(227);
  });

  /**
   * The row and the card used to carry a hardcoded 235. They no longer do, and
   * that is the point: the IR says both HUG, and they only reached 235 once the
   * venue text got the fixed 30px box the IR gives it. The pinned heights were
   * hiding a 21.6px shortfall that `justify: center` then split, pushing every
   * row inside the card down by 10.8px.
   *
   * Asserting "hug" rather than "235" means the 8px bleed has to be earned by
   * the content, which is the only version of it that stays true.
   */
  it("lets the row and card hug, so the bleed is earned not asserted", () => {
    expect(sizeOf("fixtures", "h")).toBe("auto");
    expect(sizeOf("card", "h")).toBe("auto");
    expect(h("venue")).toBe(30);
  });

  it("clips wherever the IR says clipsContent", () => {
    for (const id of ["shell", "fixtures", "card"]) expect(clips(id)).toBe(true);
  });

  it("keeps the frame the IR puts between the shell and the row", () => {
    // Dropping I1:5060;18621:42551 is what lost the centring in the first place.
    const n = tree().nodes.find((x) => x.id === "fixtures_frame")!;
    expect(n.src).toBe("I1:5060;18621:42551");
    expect(n.parent).toBe("shell");
    expect(n.props.align).toBe("center");
  });
});
