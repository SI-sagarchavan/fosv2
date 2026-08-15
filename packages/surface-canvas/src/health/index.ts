/**
 * `@fanos/surface-canvas/health` — the lint engine, published as a plain ES
 * module.
 *
 * Nothing reachable from this entry imports Figma. That is what lets the same
 * rules that power the panel run later as a CI handoff gate over the corpus:
 * `lint(parseFrameIRDocument(json), ctx)` and read the report.
 *
 * Building the `ThemeSnapshot` is the caller's job. In the plugin it comes from
 * `src/reconcile.ts` talking to the live file; in CI it would come from the
 * theme alone, with every token marked bindable (or from a recorded snapshot, if
 * the gate should also assert that the variables still exist).
 */

export type {
  Batch,
  BatchItem,
  ColorEntry,
  CoverageStatsLike,
  Finding,
  FindingScope,
  FixCandidate,
  FixProposal,
  FixTarget,
  GradientEntry,
  LintContext,
  LintOptions,
  LintReport,
  NodeField,
  NoFix,
  NumberEntry,
  OrphanBinding,
  Proposal,
  RoundProposal,
  Rule,
  Severity,
  ShadowEntry,
  StructuralAction,
  StructuralActionId,
  StructuralProposal,
  SlotKind,
  ThemeSnapshot,
  TokenBinding,
  TypeEntry,
} from "./types.js";
export {
  DEFAULT_LINT_OPTIONS,
  isFixProposal,
  isRoundProposal,
  isStructuralProposal,
} from "./types.js";

export type { KindTally, CoverageStats } from "./coverage.js";
export { computeCoverage, coverageFromSlots, emptyTally, percent } from "./coverage.js";

export type { AxisTally, PinnedText, SizingReport } from "./sizing.js";
export { emptyAxes, sizingReady, sizingReport } from "./sizing.js";

export type { ActivityActor, ActivityEntry, ActivityKind } from "./activity.js";
export {
  ACTIVITY_KEEP,
  ACTIVITY_PREFIX,
  appendLane,
  firstName,
  initialOf,
  laneKey,
  mergeActivity,
  parseLane,
  popLane,
  recentActors,
  RECENT_WINDOW_MS,
  samePerson,
} from "./activity.js";

export type { Slot, PaddingSide } from "./slots.js";
export {
  enumerateSlots,
  invalidateSlots,
  looseSlots,
  paddingFieldFor,
  paddingSideOf,
  PADDING_SIDES,
  slotsOf,
  walkNodes,
} from "./slots.js";

export type { BatchInput, QueueGroup } from "./batch.js";
export {
  batchCoverage,
  batchesToReach,
  buildBatches,
  groupQueue,
  isSafe,
  queueGroup,
  safeBatches,
  safeSlotCount,
  slotLabel,
} from "./batch.js";

export type {
  CategoryTally,
  MismatchedToken,
  MissingToken,
  ReconciliationReport,
} from "./reconcile-report.js";
export { reconciliationReport } from "./reconcile-report.js";

export type { LintEntry } from "../rules/index.js";
export { BLOCKERS, FIXABLE, lint, RULES, ruleById, WARNS } from "../rules/index.js";

export type { ColorMatch, ColorMatchOptions, ColorMetric, Lab } from "../match/color.js";
export {
  colorFamily,
  deltaE,
  deltaE2000,
  deltaE76,
  hexToLab,
  isGradient,
  matchColor,
  parseSolid,
  sameSolid,
} from "../match/color.js";

export type { NumberMatch, NumberMatchOptions } from "../match/number.js";
export { isSubpixel, matchNumber, numberEvidence } from "../match/number.js";

export type { TypeMatch } from "../match/type.js";
export { describeQuadruple, inferBreakpoint, matchType, resolveWeight } from "../match/type.js";

export { leafKeys, nameKeys, namesMatch } from "./name-keys.js";

export { classifyPaint, fieldForPropPath } from "../rules/shared.js";
export type { PaintKind, PaintValue } from "../rules/shared.js";
export { DEFAULT_NAME_RE } from "../rules/w1-default-layer-names.js";

export type { EffectGeometry, EffectMatch } from "../match/effect.js";
export { fingerprintEffect, hasEffectGeometry, matchEffect } from "../match/effect.js";
