/**
 * C4 — a raw value that is already a token.
 *
 * Every unbound number is a small piece of the design system leaking away, and
 * some of them are pure oversight: the stat strip's 60px height was written as
 * a raw with a comment saying 60 was not on the scale. `space.13` is 60. The
 * value was right, the binding was simply never looked for.
 *
 * Severity is split on purpose, so this check stays worth reading:
 *
 *   error    gap and padding — these are spacing by definition, and a spacing
 *            value that matches the spacing scale is a missed binding
 *   error    radius matching a radius token
 *   warning  width/height — a fixed design dimension can coincide with a scale
 *            step without meaning it, so this is a prompt, not a verdict
 *
 * Offsets are not checked at all: an anchored position landing on a scale step
 * is usually a coincidence, and flagging it would train people to ignore C4.
 */

import type { FlatTree } from "@fanos/dsl";
import type { NormalizedTheme } from "@fanos/tokens";
import type { ConformIssue, Severity } from "../issues.js";

type Kind = "space" | "size" | "radius" | "ignore";

/** Classify a prop path into what scale, if any, it ought to be bound to. */
function kindOf(path: readonly string[]): Kind {
  const head = path[0];
  const last = path[path.length - 1]!;
  if (head === "space") return "space";
  if (head === "size") {
    return last === "w" || last === "h" || last.startsWith("min") || last.startsWith("max")
      ? "size"
      : "ignore";
  }
  if (head === "place") return "ignore";
  if (head === "gap" || head === "columnGap" || head === "rowGap") return "space";
  if (head === "radius") return "radius";
  return "ignore";
}

function nearest(scale: ReadonlyMap<string, number>, value: number): string | undefined {
  for (const [leaf, px] of scale) if (Math.abs(px - value) < 0.01) return leaf;
  return undefined;
}

export function checkSnapping(tree: FlatTree, theme: NormalizedTheme): ConformIssue[] {
  const out: ConformIssue[] = [];

  for (const node of tree.nodes) {
    const visit = (value: unknown, path: string[]): void => {
      if (value === null || typeof value !== "object") return;
      const asRaw = value as { raw?: unknown; _unbound?: unknown };
      if (asRaw._unbound === true) {
        if (typeof asRaw.raw !== "number") return;
        const kind = kindOf(path);
        if (kind === "ignore") return;
        // Negative offsets and bleeds have no token; only positive lengths do.
        if (asRaw.raw <= 0) return;
        const scale = kind === "radius" ? theme.radius : theme.space;
        const leaf = nearest(scale, asRaw.raw);
        if (!leaf) return;
        const category = kind === "radius" ? "radius" : "space";
        const severity: Severity = kind === "size" ? "warning" : "error";
        out.push({
          code: "C4",
          severity,
          nodeId: node.id,
          message:
            `${path.join(".")} is a raw ${asRaw.raw} — that is exactly ` +
            `${category}.${leaf}${severity === "warning" ? " (check whether it means it)" : ""}`,
        });
        return;
      }
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        visit(v, [...path, k]);
      }
    };

    for (const [k, v] of Object.entries(node.props as Record<string, unknown>)) visit(v, [k]);
  }

  return out;
}
