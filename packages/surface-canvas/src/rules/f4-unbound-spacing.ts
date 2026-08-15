/**
 * F4 — a gap or padding set to a magic number.
 *
 * PURE. No Figma import.
 *
 * Zero is handled upstream in slots.ts — absent spacing is not a hardcoded
 * value, it is no value. Subpixels are offered a nearest token like any other
 * loose number; binding writes the token's value.
 */
import { enumerateSlots, paddingFieldFor, paddingSideOf } from "../health/slots.js";
import type { Finding, LintContext, NodeField, Proposal, Rule } from "../health/types.js";
import { isBindable, unbindableReason } from "../health/types.js";
import { format, matchNumber, numberEvidence, toCandidates } from "../match/number.js";
import { noMatch, slotFinding } from "./shared.js";

export const unboundSpacing: Rule = {
  id: "unbound-spacing",
  code: "F4",
  severity: "fixable",
  protects: "the spacing scale — and every responsive value derived from it",

  check(ir) {
    const findings: Finding[] = [];
    for (const slot of enumerateSlots(ir.root)) {
      if (slot.kind !== "gap" && slot.kind !== "padding") continue;
      if (slot.bound) continue;
      const value = slot.value ?? 0;

      const what = slot.kind === "gap" ? "gap" : `${paddingSideOf(slot.propPath) ?? ""} padding`.trim();
      findings.push(
        slotFinding({
          ruleId: "unbound-spacing",
          severity: "fixable",
          node: slot.node,
          scope: slot.kind,
          propPath: slot.propPath,
          currentValue: format(value),
          message:
            `${format(value)}px of ${what} is a magic number. It can't move with the spacing ` +
            "scale, and there's nothing to derive a smaller mobile value from.",
          occupiesSlot: true,
          detail: { value },
        }),
      );
    }
    return findings;
  },

  propose(finding, ctx) {
    return proposeSpacing(finding, ctx);
  },
};

function proposeSpacing(finding: Finding, ctx: LintContext): Proposal | null {
  const value = typeof finding.detail?.value === "number"
    ? finding.detail.value
    : Number.parseFloat(finding.currentValue);
  if (!Number.isFinite(value)) return null;

  const match = matchNumber(value, ctx.theme.spaces, {
    nearWithin: ctx.options.numberNearWithin,
    maxCandidates: ctx.options.maxCandidates,
  });
  if (!match) return noMatch(`${format(value)}px`);

  const field = spacingField(finding.propPath);
  if (!field) return null;

  const bindable = isBindable(match.winner);
  const proposal: Proposal = {
    kind: match.kind,
    tokenRef: match.winner.ref,
    confidence: match.kind === "exact" ? 1 : clamp(1 - match.distance / (ctx.options.numberNearWithin + 1)),
    evidence: numberEvidence(value, match),
    candidates: toCandidates(match.candidates),
    target: { type: "nodeField", field },
    bindable,
  };
  if (!bindable) {
    proposal.unbindableReason = unbindableReason(
      match.winner.ref,
      match.winner,
      `${format(match.winner.px)}px`,
    );
  }
  return proposal;
}

function spacingField(propPath: string): NodeField | undefined {
  if (propPath === "layout.gap") return "itemSpacing";
  const side = paddingSideOf(propPath);
  return side ? paddingFieldFor(side) : undefined;
}

function clamp(n: number): number {
  return Math.round(Math.min(1, Math.max(0, n)) * 100) / 100;
}
