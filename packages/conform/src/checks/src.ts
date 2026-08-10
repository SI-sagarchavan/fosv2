/**
 * C5 — `src` is the anchor everything else hangs off.
 *
 * The pixel-diff repair loop maps a mismatched region back to a node through
 * `src`; coverage and geometry both key on it. A missing one makes a node
 * unattributable, and a duplicated one makes a diff ambiguous — which is what
 * two Repeaters were quietly doing until a test went looking.
 *
 * A grouping node the design never drew is legitimate, but it must say so with
 * a `synthetic:` id rather than borrowing its parent's.
 */

import type { FlatTree } from "@fanos/dsl";
import { isSynthetic } from "@fanos/dsl";
import type { ConformIssue } from "../issues.js";
import type { IrIndex } from "../ir-index.js";

export function checkSrc(tree: FlatTree, ix: IrIndex): ConformIssue[] {
  const out: ConformIssue[] = [];
  const seen = new Map<string, string>();

  for (const node of tree.nodes) {
    const src = node.src;
    if (typeof src !== "string" || src.trim() === "") {
      out.push({
        code: "C5",
        severity: "error",
        nodeId: node.id,
        message: `no src — nothing to map a diff region back to`,
      });
      continue;
    }

    const prev = seen.get(src);
    if (prev !== undefined) {
      out.push({
        code: "C5",
        severity: "error",
        nodeId: node.id,
        irId: src,
        message:
          `src "${src}" is already used by "${prev}" — a diff region here maps to two ` +
          `nodes. A grouping node with no Figma counterpart wants synthetic:${src}:N`,
      });
    } else {
      seen.set(src, node.id);
    }

    // A synthetic id must still point at a real node, or it anchors nothing.
    const base = isSynthetic(src) ? src.slice("synthetic:".length).replace(/:\d+$/, "") : src;
    if (!ix.byId.has(base)) {
      out.push({
        code: "C5",
        severity: "error",
        nodeId: node.id,
        irId: src,
        message: `src "${src}" is not in this IR document`,
      });
    }
  }

  return out;
}
