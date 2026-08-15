/**
 * Helpers shared by the rules. PURE — no Figma import.
 */
import type { FrameIRNode } from "../ir/schema.js";
import type { Finding, NodeField, NoFix, Severity } from "../health/types.js";
import { paddingFieldFor, paddingSideOf } from "../health/slots.js";
import { isGradient, parseSolid } from "../match/color.js";

export type PaintKind = "solid" | "gradient" | "image" | "mixed" | "unknown";

export interface PaintValue {
  kind: PaintKind;
  /**
   * The batching key. Every linear gradient collapses to `linear-gradient`:
   * 243 unique gradient strings would otherwise produce 243 batches of one,
   * which is a list nobody can act on. The verbatim string survives in
   * `Finding.rawValue`, and the batch reports how many distinct ones it holds.
   */
  key: string;
  raw: string;
}

export function classifyPaint(raw: string | undefined): PaintValue {
  const value = raw ?? "";
  if (parseSolid(value)) return { kind: "solid", key: value.trim().toLowerCase(), raw: value };
  if (isGradient(value)) {
    const type = value.slice("GRADIENT_".length).split("(")[0]!.toLowerCase();
    return { kind: "gradient", key: `${type}-gradient`, raw: value };
  }
  if (value.startsWith("IMAGE")) return { kind: "image", key: "image", raw: value };
  if (value === "MIXED") return { kind: "mixed", key: "mixed", raw: value };
  return { kind: "unknown", key: value.length > 0 ? value : "unknown", raw: value };
}

export const GRADIENT_NO_FIX: NoFix = {
  kind: "none",
  reason: "Gradients need a surface recipe authored before anything can bind to them.",
  hint: "Author these as surface tokens in the theme, then re-run — a gradient is a composition, not a single value.",
};

export const IMAGE_NO_FIX: NoFix = {
  kind: "none",
  reason: "An image fill is content, not a token. There is nothing to bind.",
  hint: "Leave it. Images are resolved from data at generation time, not from the theme.",
};

export const MIXED_NO_FIX: NoFix = {
  kind: "none",
  reason: "The layer has more than one fill, so it has no single value to bind.",
  hint: "Flatten to one fill, or split the layer.",
};

export function noMatch(what: string): NoFix {
  return {
    kind: "none",
    reason: `No token in this theme is close to ${what}.`,
    hint: "Either add it to the theme or change the layer to a value the theme already has.",
  };
}

/** Builds a slot finding. Blockers and warns use {@link pageFinding}. */
export function slotFinding(args: {
  ruleId: string;
  severity: Severity;
  node: FrameIRNode;
  scope: Finding["scope"];
  propPath: string;
  currentValue: string;
  rawValue?: string;
  message: string;
  occupiesSlot: boolean;
  hint?: string;
  /**
   * Structured values `propose()` needs. Carrying them here rather than
   * re-parsing them out of `currentValue` is deliberate: a display string is a
   * display string, and round-tripping one is how a font called "Semi Bold"
   * ends up matching nothing.
   */
  detail?: Record<string, number | string>;
}): Finding {
  const finding: Finding = {
    ruleId: args.ruleId,
    severity: args.severity,
    nodeId: args.node.id,
    nodeName: args.node.name,
    nodeType: args.node.type,
    scope: args.scope,
    propPath: args.propPath,
    currentValue: args.currentValue,
    message: args.message,
    occupiesSlot: args.occupiesSlot,
  };
  if (args.rawValue !== undefined && args.rawValue !== args.currentValue) {
    finding.rawValue = args.rawValue;
  }
  if (args.hint !== undefined) finding.hint = args.hint;
  if (args.detail !== undefined) finding.detail = args.detail;
  return finding;
}

export function pageFinding(args: {
  ruleId: string;
  severity: Severity;
  nodeId: string;
  nodeName: string;
  propPath: string;
  currentValue: string;
  message: string;
  hint?: string;
  detail?: Record<string, number | string>;
  nodeIds?: string[];
}): Finding {
  const finding: Finding = {
    ruleId: args.ruleId,
    severity: args.severity,
    nodeId: args.nodeId,
    nodeName: args.nodeName,
    nodeType: "PAGE",
    scope: "page",
    propPath: args.propPath,
    currentValue: args.currentValue,
    message: args.message,
    occupiesSlot: false,
  };
  if (args.hint !== undefined) finding.hint = args.hint;
  if (args.detail !== undefined) finding.detail = args.detail;
  if (args.nodeIds !== undefined) finding.nodeIds = args.nodeIds;
  return finding;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/** Slot address → the Figma field a round or bind writes. */
export function fieldForPropPath(propPath: string): NodeField | undefined {
  if (propPath === "layout.gap") return "itemSpacing";
  if (propPath === "radius") return "cornerRadius";
  const side = paddingSideOf(propPath);
  return side ? paddingFieldFor(side) : undefined;
}
