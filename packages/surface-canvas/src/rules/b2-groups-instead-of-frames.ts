/**
 * B2 — groups where frames are needed.
 *
 * PURE. No Figma import.
 *
 * The layer count is over DISTINCT descendants. Nested groups would otherwise
 * be counted once per ancestor, and a number that overstates the problem is
 * still a wrong number when the designer counts the layers themselves.
 */
import { walkNodes } from "../health/slots.js";
import type { Rule } from "../health/types.js";
import { pageFinding, plural } from "./shared.js";

export const groupsInsteadOfFrames: Rule = {
  id: "groups-instead-of-frames",
  code: "B2",
  severity: "blocker",
  protects: "responsive layout — a group has no layout to inherit",

  check(ir) {
    const groups = walkNodes(ir.root).filter((node) => node.type === "GROUP");
    if (groups.length === 0) return [];

    const held = new Set<string>();
    for (const group of groups) {
      for (const descendant of walkNodes(group)) {
        if (descendant.id !== group.id) held.add(descendant.id);
      }
    }

    const n = groups.length;
    const m = held.size;
    return [
      pageFinding({
        ruleId: "groups-instead-of-frames",
        severity: "blocker",
        nodeId: "",
        nodeName: ir.pageName,
        propPath: "type",
        currentValue: "GROUP",
        message: `${n} ${plural(n, "group")} · ${m} ${plural(m, "layer")}`,
        hint: "Groups have no layout. Convert to frames so contents can hug, fill or stack.",
        detail: { groups: n, layers: m },
        nodeIds: groups.map((group) => group.id),
      }),
    ];
  },

  propose(finding) {
    const n = typeof finding.detail?.groups === "number" ? finding.detail.groups : 0;
    return {
      kind: "structural" as const,
      action: "convert-groups" as const,
      nodeIds: finding.nodeIds ?? [],
      label: `Turn ${n} ${n === 1 ? "group" : "groups"} into frames`,
    };
  },
};
