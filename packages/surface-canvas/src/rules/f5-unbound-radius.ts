/**
 * F5 — a corner radius set to a magic number.
 *
 * PURE. No Figma import.
 *
 * Zero counts here, unlike spacing. `radius.none` exists in the theme, and a
 * bound zero is a decision that survives generation while a loose zero is
 * indistinguishable from nobody having thought about it. That asymmetry is the
 * one place this package's denominator differs from the exporter's — see README.
 *
 */
import { enumerateSlots } from "../health/slots.js";
import type { Finding, LintContext, Proposal, Rule } from "../health/types.js";
import { isBindable, unbindableReason } from "../health/types.js";
import { format, matchNumber, numberEvidence, toCandidates } from "../match/number.js";
import { noMatch, slotFinding } from "./shared.js";

export const unboundRadius: Rule = {
  id: "unbound-radius",
  code: "F5",
  severity: "fixable",
  protects: "the radius scale — a per-layer corner can't follow a tenant's shape language",

  check(ir) {
    const findings: Finding[] = [];
    for (const slot of enumerateSlots(ir.root)) {
      if (slot.kind !== "radius" || slot.bound) continue;
      const value = slot.value ?? 0;

      findings.push(
        slotFinding({
          ruleId: "unbound-radius",
          severity: "fixable",
          node: slot.node,
          scope: "radius",
          propPath: slot.propPath,
          currentValue: format(value),
          message:
            value === 0
              ? "A loose 0 radius reads exactly like nobody having decided. Bound to radius.none it survives generation as a choice."
              : `A hardcoded ${format(value)}px radius can't follow the radius scale — a tenant with softer corners won't reach this layer.`,
          occupiesSlot: true,
          detail: { value },
        }),
      );
    }
    return findings;
  },

  propose(finding, ctx) {
    return proposeRadius(finding, ctx);
  },
};

function proposeRadius(finding: Finding, ctx: LintContext): Proposal | null {
  const value = typeof finding.detail?.value === "number"
    ? finding.detail.value
    : Number.parseFloat(finding.currentValue);
  if (!Number.isFinite(value)) return null;

  const match = matchNumber(value, ctx.theme.radii, {
    nearWithin: ctx.options.numberNearWithin,
    maxCandidates: ctx.options.maxCandidates,
  });
  if (!match) return noMatch(`a ${format(value)}px radius`);

  const bindable = isBindable(match.winner);
  const proposal: Proposal = {
    kind: match.kind,
    tokenRef: match.winner.ref,
    confidence:
      match.kind === "exact" ? 1 : clamp(1 - match.distance / (ctx.options.numberNearWithin + 1)),
    evidence: numberEvidence(value, match),
    candidates: toCandidates(match.candidates),
    // Uniform corners bind through `cornerRadius`; fix.ts falls back to the
    // four individual corners when Figma refuses (mixed radii).
    target: { type: "nodeField", field: "cornerRadius" },
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

function clamp(n: number): number {
  return Math.round(Math.min(1, Math.max(0, n)) * 100) / 100;
}
