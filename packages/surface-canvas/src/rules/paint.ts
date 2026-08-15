/**
 * The shared half of F1 (fill) and F2 (stroke). PURE — no Figma import.
 *
 * Fills and strokes differ in exactly two places: which slot they read and what
 * breaks downstream. Everything else — gradient handling, ΔE candidates, the
 * bindability check — is one implementation, because two copies of a colour
 * matcher is two colour matchers to keep in agreement.
 */
import { enumerateSlots } from "../health/slots.js";
import type { Finding, LintContext, Proposal, Rule, SlotKind } from "../health/types.js";
import { isBindable, unbindableReason } from "../health/types.js";
import { matchColor, round, toCandidates } from "../match/color.js";
import {
  classifyPaint,
  GRADIENT_NO_FIX,
  IMAGE_NO_FIX,
  MIXED_NO_FIX,
  noMatch,
  slotFinding,
} from "./shared.js";

export interface PaintRuleSpec {
  id: string;
  code: string;
  slot: Extract<SlotKind, "fill" | "stroke">;
  protects: string;
  /** Consequence copy per paint kind. `{value}` is substituted. */
  message(kind: ReturnType<typeof classifyPaint>["kind"], value: string): string;
}

export function paintRule(spec: PaintRuleSpec): Rule {
  return {
    id: spec.id,
    code: spec.code,
    severity: "fixable",
    protects: spec.protects,

    check(ir) {
      const findings: Finding[] = [];
      for (const slot of enumerateSlots(ir.root)) {
        if (slot.kind !== spec.slot || slot.bound) continue;
        const paint = classifyPaint(slot.raw);
        findings.push(
          slotFinding({
            ruleId: spec.id,
            severity: "fixable",
            node: slot.node,
            scope: spec.slot,
            propPath: slot.propPath,
            currentValue: paint.key,
            rawValue: paint.raw,
            message: spec.message(paint.kind, paint.key),
            occupiesSlot: true,
          }),
        );
      }
      return findings;
    },

    propose(finding, ctx) {
      return proposePaint(finding, ctx, spec.slot);
    },
  };
}

export function proposePaint(
  finding: Finding,
  ctx: LintContext,
  slot: "fill" | "stroke",
): Proposal | null {
  const paint = classifyPaint(finding.rawValue ?? finding.currentValue);
  if (paint.kind === "gradient") return GRADIENT_NO_FIX;
  if (paint.kind === "image") return IMAGE_NO_FIX;
  if (paint.kind === "mixed") return MIXED_NO_FIX;
  if (paint.kind === "unknown") return noMatch(paint.key);

  const match = matchColor(paint.raw, ctx.theme.colors, {
    metric: ctx.options.colorMetric,
    threshold: ctx.options.colorNearThreshold,
    maxCandidates: ctx.options.maxCandidates,
  });
  if (!match) return noMatch(paint.key);

  const bindable = isBindable(match.winner);
  const proposal: Proposal = {
    kind: match.kind,
    tokenRef: match.winner.ref,
    confidence:
      match.kind === "exact"
        ? 1
        : round(Math.max(0, 1 - match.distance / ctx.options.colorNearThreshold), 2),
    evidence:
      match.kind === "exact"
        ? `${paint.key} === ${match.winner.ref}`
        : `ΔE ${round(match.distance, 1)}`,
    candidates: toCandidates(match.candidates),
    target: { type: "paint", slot },
    bindable,
  };
  if (!bindable) {
    proposal.unbindableReason = unbindableReason(
      match.winner.ref,
      match.winner,
      match.winner.hex,
    );
  }
  return proposal;
}
