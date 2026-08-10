/**
 * Conformance issues.
 *
 * Distinct from `@fanos/dsl`'s validator, and the distinction is the whole
 * point. That one asks "is this tree LEGAL" — do the refs resolve, is it
 * single-rooted, is `place.anchor` under an Overlay. This one asks "is this
 * tree TRUE" — does it still say what the Figma frame said.
 *
 * A tree missing half its nodes is perfectly legal. Every fidelity bug found by
 * hand while building the first five examples passed `validate()` with zero
 * errors and zero warnings; not one would have been caught without these.
 */

export const CONFORM_CODES = {
  C1: "C1",
  C2: "C2",
  C3: "C3",
  C4: "C4",
  C5: "C5",
} as const;

export type ConformCode = keyof typeof CONFORM_CODES;

export const CODE_TITLES: Record<ConformCode, string> = {
  C1: "coverage — an IR node that paints is not represented in the tree",
  C2: "geometry — a node renders at a different box than the IR records",
  C3: "sizing — a hardcoded px where the IR says hug/fill",
  C4: "snapping — a raw value that exactly equals an existing token",
  C5: "src — missing, malformed, or duplicated Figma node id",
};

export type Severity = "error" | "warning" | "info";

export interface ConformIssue {
  code: ConformCode;
  severity: Severity;
  /** DSL node id, when the issue is about a node we emitted. */
  nodeId?: string;
  /** Figma node id, when the issue is about a node we did NOT emit. */
  irId?: string;
  message: string;
  /** Set when a `_meta.deviations` entry suppressed this from being an error. */
  waived?: string;
}

export interface ConformSummary {
  /** IR nodes that paint, and how they are accounted for. */
  coverage: {
    paints: number;
    direct: number;
    absorbed: number;
    repeated: number;
    missing: number;
  };
  /** Nodes compared by C2, and the worst delta seen. */
  geometry: { compared: number; skipped: number; worstDelta: number };
  nodeCount: number;
  waived: number;
}

export interface ConformResult {
  ok: boolean;
  errors: ConformIssue[];
  warnings: ConformIssue[];
  infos: ConformIssue[];
  summary: ConformSummary;
}

export function issuesByCode(issues: readonly ConformIssue[]): Record<string, ConformIssue[]> {
  const out: Record<string, ConformIssue[]> = {};
  for (const i of issues) (out[i.code] ??= []).push(i);
  return out;
}
