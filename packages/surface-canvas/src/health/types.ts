/**
 * The vocabulary the lint engine speaks.
 *
 * Everything in this file — and everything under `src/health/`, `src/rules/`
 * and `src/match/` — is Figma-free by construction. Rules run on Frame IR, so
 * the same engine runs in the plugin and (later) in CI as a handoff gate, and a
 * rule change is a diff you can replay across the whole corpus.
 *
 * The one seam is {@link ThemeSnapshot}: `src/reconcile.ts` talks to Figma to
 * discover which tokens actually exist as variables and styles, then hands the
 * result over as plain data. A rule never asks Figma anything.
 */
import type { Breakpoint, Rgb, TypeValue } from "@fanos/tokens";
import type { FrameIRDocument, IRNodeType } from "../ir/schema.js";
import type { SizingReport } from "./sizing.js";

export type Severity = "blocker" | "fixable" | "warn";

/**
 * The unit of coverage. Every slot in a page is either bound to a token/style
 * or loose, and the score is nothing more than a count over these.
 */
export type SlotKind =
  | "fill"
  | "stroke"
  | "gap"
  | "padding"
  | "radius"
  | "text"
  | "effect";

/** Page-level rules (blockers, the naming warn) report once, not per slot. */
export type FindingScope = SlotKind | "page";

export interface Finding {
  ruleId: string;
  severity: Severity;
  /** Empty string for page-level findings that belong to no single node. */
  nodeId: string;
  nodeName: string;
  nodeType: IRNodeType | "PAGE";
  scope: FindingScope;
  /** `layout.padding.top`, `fill`, `effects.0` — addresses the exact slot. */
  propPath: string;
  /**
   * The batching key, deliberately normalized: every linear gradient collapses
   * to `linear-gradient` so 243 one-off gradients form one reviewable batch
   * rather than 243 batches of one.
   */
  currentValue: string;
  /** The verbatim IR value, when `currentValue` normalized it away. */
  rawValue?: string;
  /** Names the CONSEQUENCE. Never the convention. */
  message: string;
  /**
   * True when this finding occupies a coverage slot — i.e. it is one of the
   * loose values in the denominator. Blockers and warns do not.
   */
  occupiesSlot: boolean;
  /** Aggregate numbers for page-level findings, rendered into the UI as-is. */
  detail?: Record<string, number | string>;
  /** Set by page-level rules that can list the nodes they are talking about. */
  nodeIds?: string[];
  /** No autofix exists; this is what the designer has to do instead. */
  hint?: string;
}

/** How a proposal is applied. Figma-agnostic on purpose — `fix.ts` maps it. */
export type FixTarget =
  | { type: "paint"; slot: "fill" | "stroke" }
  | { type: "nodeField"; field: NodeField }
  | { type: "textStyle" }
  | { type: "effectStyle" }
  | { type: "round"; field: NodeField };

/**
 * The subset of Figma's `VariableBindableNodeField` this plugin ever writes.
 * Kept as a local union so `src/rules/` does not import plugin typings.
 */
export type NodeField =
  | "itemSpacing"
  | "paddingTop"
  | "paddingRight"
  | "paddingBottom"
  | "paddingLeft"
  | "cornerRadius"
  | "topLeftRadius"
  | "topRightRadius"
  | "bottomLeftRadius"
  | "bottomRightRadius";

export interface FixCandidate {
  tokenRef: string;
  /** ΔE for colours, absolute px delta for numbers. 0 for an exact hit. */
  distance: number;
  /** Rendered value — a hex for a swatch, `16px` for a number. */
  value: string;
  /** False when the token has no Figma variable behind it. */
  bindable: boolean;
}

export interface FixProposal {
  kind: "exact" | "near";
  tokenRef: string;
  /** 1 for exact; for near, falls off with distance. */
  confidence: number;
  /** `10px === space.2_5`, `ΔE 4.1`. */
  evidence?: string;
  /** Always includes the winner at index 0. */
  candidates: FixCandidate[];
  target: FixTarget;
  /**
   * False when the winning token has no matching Figma variable or style. The
   * UI disables the button and says why rather than offering a fix that fails.
   */
  bindable: boolean;
  unbindableReason?: string;
}

/** A loose value with no fix available, and the reason — gradients, unmatched type. */
export interface NoFix {
  kind: "none";
  reason: string;
  hint: string;
}

/** F7 — write a whole-pixel value. Not a token bind; it unblocks F4/F5. */
export interface RoundProposal {
  kind: "round";
  roundedTo: number;
  target: Extract<FixTarget, { type: "round" }>;
}

/** B1/B2 — a structural change on the page, not a slot bind. */
export interface StructuralProposal {
  kind: "structural";
  action: StructuralActionId;
  nodeIds: string[];
  label: string;
}

export type StructuralActionId = "wrap-autolayout" | "convert-groups";

export interface StructuralAction {
  id: StructuralActionId;
  ruleId: string;
  ruleCode: string;
  label: string;
  hint: string;
  count: number;
  nodeIds: string[];
}

export type Proposal = FixProposal | RoundProposal | StructuralProposal | NoFix;

/** A token bind — exact or near. Not a round or a structural change. */
export function isFixProposal(p: Proposal): p is FixProposal {
  return p.kind === "exact" || p.kind === "near";
}

export function isRoundProposal(p: Proposal): p is RoundProposal {
  return p.kind === "round";
}

export function isStructuralProposal(p: Proposal): p is StructuralProposal {
  return p.kind === "structural";
}

// ---------------------------------------------------------------------------
// The reconciled theme — the only bridge between Figma and the pure engine
// ---------------------------------------------------------------------------

/** What actually exists in the Figma file behind a token. */
export interface TokenBinding {
  /**
   * `libraryVariable` is a variable that lives in a published library and has
   * not been pulled into this file yet. It binds exactly like any other, but it
   * has to be imported by key first — which `fix.ts` does at apply time rather
   * than eagerly, so checking a file never adds 250 variables to it.
   */
  medium: "variable" | "libraryVariable" | "textStyle" | "effectStyle";
  /** Figma variable or style id, for `fix.ts` to resolve and apply. */
  id: string;
  /** Library variables are addressed by key, not id, until they are imported. */
  key?: string;
  /** Which library it came from, for the reconciliation report. */
  library?: string;
  /**
   * True when this Variable is an imported library copy. Bind through `id`.
   * Do not `setValueForMode` — Figma throws on remote variables.
   */
  remote?: boolean;
  /** Full Figma name, e.g. `Spacing/spacing_4`. */
  figmaName: string;
  collection?: string;
  /**
   * The variable's own value in its collection's default mode, rendered.
   *
   * This is checked, not assumed. A Figma variable named `spacing_4` holding
   * 20 while the theme says 16 would turn "bind 60 layers" into "move 60
   * layers", which is the single worst thing this plugin could do. A mismatch
   * makes the token unbindable with the numbers in the reason.
   */
  figmaValue?: string;
  /** undefined when the value could not be resolved (deep alias chain). */
  valueMatches?: boolean;
}

export interface ColorEntry {
  ref: string;
  raw: string;
  hex: string;
  rgb: Rgb;
  /**
   * `core_prim_400` -> `core_prim`. Near-match candidates are scoped to one
   * family: offering a designer an *error* red for a *brand* red is a semantic
   * mistake dressed up as a measurement.
   */
  family: string;
  binding?: TokenBinding;
}

export interface NumberEntry {
  ref: string;
  raw: string;
  px: number;
  binding?: TokenBinding;
}

export interface TypeEntry {
  ref: string;
  raw: string;
  byBreakpoint: Partial<Record<Breakpoint, TypeValue>>;
  binding?: TokenBinding;
}

export interface ShadowEntry {
  ref: string;
  raw: string;
  /** One-line rendering, for the UI. */
  value: string;
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: string;
  /** 0–100. */
  opacity: number;
  inset: boolean;
  binding?: TokenBinding;
}

export interface GradientEntry {
  ref: string;
  raw: string;
  value: string;
  binding?: TokenBinding;
}

/** A Figma variable with no token behind it. Design-ops signal, not a finding. */
export interface OrphanBinding {
  medium: "variable" | "textStyle" | "effectStyle";
  figmaName: string;
  collection?: string;
  resolvedType?: string;
}

/**
 * A token is bindable when a Figma variable or style exists for it AND holds
 * the value the theme says it does.
 *
 * The second half is the whole reason this is a function rather than a
 * `!== undefined` check at each call site: a variable named `spacing_4` holding
 * 20px is worse than no variable at all, because it turns a safe bulk bind into
 * a silent 60-layer re-space.
 */
export function isBindable(entry: { binding?: TokenBinding }): boolean {
  return entry.binding !== undefined && entry.binding.valueMatches !== false;
}

/** Why a token cannot be bound, in words a designer can act on. */
export function unbindableReason(
  ref: string,
  entry: { binding?: TokenBinding },
  expected: string,
): string {
  const binding = entry.binding;
  if (!binding) {
    const what = "no matching Figma variable in this file";
    return `${ref} has ${what}. Create it (or publish it locally) and this batch turns on.`;
  }
  if (binding.valueMatches === false) {
    return (
      `Figma's "${binding.figmaName}" holds ${binding.figmaValue ?? "a different value"} ` +
      `but the theme says ${expected}. Binding would change the layer, not just label it — ` +
      "fix the variable first."
    );
  }
  return `${ref} can't be bound in this file.`;
}

export interface ThemeSnapshot {
  themeId: string;
  themeName: string;
  slug: string;
  colors: ColorEntry[];
  spaces: NumberEntry[];
  radii: NumberEntry[];
  types: TypeEntry[];
  shadows: ShadowEntry[];
  gradients: GradientEntry[];
  orphans: OrphanBinding[];
  /** True when reconciliation ran against a real file rather than a stub. */
  reconciled: boolean;
  /**
   * Local variable collections found. Zero is a distinct, common state — a file
   * whose variables all come from a published library — and it has to be said
   * out loud, or the panel looks broken instead of unimplemented.
   */
  localCollections: number;
  /**
   * Enabled libraries publishing variables. A file with 0 local collections and
   * a healthy library count is the normal shape for a design-system consumer —
   * and the case v0.1 originally could not bind at all.
   */
  libraryCollections: number;
  /** Set when the library lookup failed — missing permission, no access. */
  libraryError?: string;
  /** Tokens whose Figma variable exists but holds a different value. */
  valueMismatches: number;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export interface LintOptions {
  /**
   * Colour near-match metric. CIE76 is the shipped default: it is cheap,
   * deterministic and, at the threshold below, conservative. See README for the
   * measured comparison against CIEDE2000 on the reference palette.
   */
  colorMetric: "cie76" | "ciede2000";
  colorNearThreshold: number;
  /** px window for a numeric near-match. */
  numberNearWithin: number;
  maxCandidates: number;
  /** Mobile-frame detection window for B3. */
  mobileWidthRange: [number, number];
}

export const DEFAULT_LINT_OPTIONS: LintOptions = {
  colorMetric: "cie76",
  // 13, not the textbook 10 — see README, "The ΔE threshold".
  colorNearThreshold: 13,
  numberNearWithin: 2,
  maxCandidates: 3,
  mobileWidthRange: [320, 480],
};

export interface LintContext {
  theme: ThemeSnapshot;
  /** Inferred from the root frame width, not asked of the designer. */
  breakpoint: Breakpoint;
  options: LintOptions;
}

/**
 * Everything the panel draws, in one serializable object.
 *
 * Serializable matters: this crosses `figma.ui.postMessage` into the iframe, so
 * no Maps, no functions, no class instances anywhere in it.
 */
export interface LintReport {
  irVersion: string;
  fileName: string;
  pageName: string;
  rootNodeId: string;
  /** The frame actually being checked. Shown in the panel so a wrong pick is visible. */
  rootName: string;
  themeId: string;
  themeName: string;
  breakpoint: Breakpoint;
  coverage: CoverageStatsLike;
  /** Hug / fill / fixed, plus text that will clip when copy is bound. */
  sizing: SizingReport;
  blockers: Finding[];
  warns: Finding[];
  batches: Batch[];
  /** Blocker fixes that can run from the panel — wrap, convert groups. */
  actions: StructuralAction[];
  fixableFindings: number;
  /** How many batches it takes to reach 90% of the loose values. */
  batchesFor90Percent: number;
  distinctLooseValues: number;
  options: LintOptions;
  durationMs: number;
}

/**
 * Structural mirror of `CoverageStats` in coverage.ts, declared here so the
 * type vocabulary has no import cycle with the module that computes it.
 */
export interface CoverageStatsLike {
  total: number;
  bound: number;
  loose: number;
  percent: number;
  oneClickAway: number;
  oneClickPercent: number;
  projectedPercent: number;
  byKind: Record<SlotKind, { total: number; bound: number; loose: number }>;
}

/** One loose slot inside a batch. Enough to select it and to fix it. */
export interface BatchItem {
  nodeId: string;
  propPath: string;
}

export interface Batch {
  /** `unbound-fill|fill|#ffffff|color.core_neu_00` — stable across re-lints. */
  id: string;
  ruleId: string;
  ruleCode: string;
  scope: FindingScope;
  currentValue: string;
  /** `fill #ffffff`, `gap 10`. */
  label: string;
  slotLabel: string;
  count: number;
  /**
   * How many verbatim values folded into this batch. 1 for `#ffffff`; for the
   * gradient batch it is the number of distinct gradients, which is the number
   * of surface recipes somebody has to author.
   */
  distinctRawValues: number;
  proposal: Proposal | null;
  /** Percentage points of coverage this batch is worth. */
  coverageGain: number;
  safe: boolean;
  /** The first finding's message — they are identical within a batch. */
  message: string;
  items: BatchItem[];
}

export interface Rule {
  /** Kebab id, e.g. `unbound-spacing`. Stable; it lands in every finding. */
  id: string;
  /** Short code the panel shows, e.g. `F4`. */
  code: string;
  severity: Severity;
  /** The downstream capability that breaks without this rule. */
  protects: string;
  check(ir: FrameIRDocument, ctx: LintContext): Finding[];
  propose?(finding: Finding, ctx: LintContext): Proposal | null;
}
