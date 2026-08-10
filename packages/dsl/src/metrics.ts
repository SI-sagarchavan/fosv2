/**
 * Part 6 — Quality metrics (Q1–Q6).
 *
 * Counted, never blocking. Raw escapes are legitimate under static-fidelity
 * scope; what is NOT acceptable is letting them pass unreported, so every one is
 * counted and the count is part of the validator's return value rather than
 * something a caller has to ask for.
 *
 * `rawValueCount` is split by debt class so design-system debt (space/color/
 * size) and missing-scale debt (duration, before the motion scale existed) never
 * sum into one number that confuses the repair loop.
 *
 * Pure. No I/O.
 */

import { depths, isSynthetic, type FlatTree } from "./flat.js";
import { allFields, nodeSpec } from "./nodes/index.js";
import type { FieldType } from "./field.js";
import { isRaw, isSignedTokenRef } from "./values.js";
import { walkProps } from "./walk.js";

/** Design-debt classes. `total` is the sum, kept for coverage maths. */
export interface RawValueCount {
  space: number;
  color: number;
  size: number;
  duration: number;
  other: number;
  total: number;
}

export interface Metrics {
  /**
   * Q1 — Raw<T> occurrences, split by debt class.
   * `total` is what used to be the single rawValueCount number.
   */
  rawValueCount: RawValueCount;
  /** Q2 — Raw inside `place.offset` specifically. Position debt is the worst kind. */
  rawPositionCount: number;
  /** Q3 — nodes the agent inserted with no Figma origin. */
  syntheticNodeCount: number;
  /** Q4 — Custom nodes, which are opaque to every downstream consumer. */
  customNodeCount: number;
  /** Q5 — tokenised / (tokenised + raw.total). 1 when there is nothing to measure. */
  tokenCoverage: number;
  /** Q6 */
  maxDepth: number;
  nodeCount: number;
  /** Supporting counts, so a report can explain the coverage ratio. */
  tokenisedValueCount: number;
  /** Percentages and keywords: relative, survive breakpoints, NOT raw debt. */
  relativeValueCount: number;
}

/** Field kinds that can hold a token ref, and therefore participate in coverage. */
const TOKEN_BEARING = new Set(["token", "val", "size", "offset"]);

function emptyRawCount(): RawValueCount {
  return { space: 0, color: 0, size: 0, duration: 0, other: 0, total: 0 };
}

/**
 * Classify a raw escape by the field it sits on — not by the raw value itself.
 * A raw number on `size.w` is size debt; on `revealDelay` it is duration debt.
 */
function rawDebtClass(type: FieldType, path: string): keyof Omit<RawValueCount, "total"> {
  if (type.k === "size") return "size";
  if (type.k === "offset") return "space";
  if (type.k === "val") {
    if (type.category === "duration") return "duration";
    return "space";
  }
  if (type.k === "token") {
    if (type.category === "color") return "color";
    if (type.category === "duration") return "duration";
    if (type.category === "space" || type.category === "radius") return "space";
    return "other";
  }
  // Fall back on path heuristics for unions that lost type info.
  if (path.includes("revealDelay") || path.includes("autoplay")) return "duration";
  if (/\b(size|w|h|minW|maxW|minH|maxH)\b/.test(path)) return "size";
  return "other";
}

export function analyze(tree: FlatTree): Metrics {
  const rawValueCount = emptyRawCount();
  let rawPositionCount = 0;
  let tokenisedValueCount = 0;
  let relativeValueCount = 0;
  let syntheticNodeCount = 0;
  let customNodeCount = 0;

  for (const node of tree.nodes) {
    if (isSynthetic(node.src)) syntheticNodeCount += 1;
    if (node.type === "Custom") customNodeCount += 1;

    const spec = nodeSpec(node.type);
    if (!spec) continue;

    walkProps(allFields(spec), node.props, {
      leaf: ({ path, value, type }) => {
        if (!TOKEN_BEARING.has(type.k)) return;
        if (isRaw(value)) {
          const cls = rawDebtClass(type, path);
          rawValueCount[cls] += 1;
          rawValueCount.total += 1;
          if (path.startsWith("place.offset")) rawPositionCount += 1;
          return;
        }
        if (isSignedTokenRef(value)) {
          tokenisedValueCount += 1;
          return;
        }
        if (typeof value === "string") relativeValueCount += 1;
      },
    });
  }

  const denominator = tokenisedValueCount + rawValueCount.total;
  const depthMap = depths(tree);

  return {
    rawValueCount,
    rawPositionCount,
    syntheticNodeCount,
    customNodeCount,
    tokenCoverage: denominator === 0 ? 1 : Number((tokenisedValueCount / denominator).toFixed(4)),
    maxDepth: depthMap.size === 0 ? 0 : Math.max(...depthMap.values()),
    nodeCount: tree.nodes.length,
    tokenisedValueCount,
    relativeValueCount,
  };
}

