/**
 * W1 — layers still carrying the name Figma gave them.
 *
 * PURE. No Figma import.
 *
 * The percentage EXCLUDES vector nodes. Vectors are roughly 44% of a real file
 * and their names are meaningless by nature — counting them would put the number
 * somewhere in the seventies and make the metric unactionable. Excluding them
 * makes it a statement about layers a human actually named.
 */
import { walkNodes } from "../health/slots.js";
import type { Rule } from "../health/types.js";
import { pageFinding } from "./shared.js";

export const DEFAULT_NAME_RE =
  /^(Frame|Group|Rectangle|Ellipse|Vector|Component|Instance|Union|Subtract|Line|image)\s*[\d_]*$/;

const MAX_LISTED = 200;

export const defaultLayerNames: Rule = {
  id: "default-layer-names",
  code: "W1",
  severity: "warn",
  protects:
    "intent — a generator that can't read a layer's purpose from its name has to invent one",

  check(ir) {
    const named = walkNodes(ir.root).filter((node) => node.type !== "VECTOR");
    if (named.length === 0) return [];

    const defaults = named.filter((node) => DEFAULT_NAME_RE.test(node.name.trim()));
    if (defaults.length === 0) return [];

    const pct = Math.round((defaults.length / named.length) * 1000) / 10;
    return [
      pageFinding({
        ruleId: "default-layer-names",
        severity: "warn",
        nodeId: "",
        nodeName: ir.pageName,
        propPath: "name",
        currentValue: `${pct}%`,
        message:
          `${pct}% of named layers still say "Frame 427" or similar (${defaults.length} of ${named.length}, ` +
          "vectors excluded). Nothing downstream can read intent off those, so section and " +
          "component names get invented instead of inherited.",
        hint: "Rename the containers first — the leaves matter far less than the frames that will become sections.",
        detail: {
          percent: pct,
          defaultNamed: defaults.length,
          consideredNodes: named.length,
          excludedVectors: walkNodes(ir.root).length - named.length,
        },
        nodeIds: defaults.slice(0, MAX_LISTED).map((node) => node.id),
      }),
    ];
  },
};
