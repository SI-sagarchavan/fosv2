/**
 * F3 — text set per-layer instead of through a type style.
 *
 * PURE. No Figma import.
 *
 * Matching is on the full quadruple (family, size, weight, lineHeight) against
 * the theme's typography set for the breakpoint inferred from the page width.
 * Exact only — see src/match/type.ts for why there is no near-matching type.
 */
import { enumerateSlots } from "../health/slots.js";
import type { Finding, LintContext, Proposal, Rule } from "../health/types.js";
import { isBindable } from "../health/types.js";
import { describeQuadruple, matchType } from "../match/type.js";
import { noMatch, slotFinding } from "./shared.js";

export const unboundTextStyle: Rule = {
  id: "unbound-text-style",
  code: "F3",
  severity: "fixable",
  protects: "the type scale — per-layer text never receives a change to the scale",

  check(ir) {
    const findings: Finding[] = [];
    for (const slot of enumerateSlots(ir.root)) {
      if (slot.kind !== "text" || slot.bound) continue;
      const text = slot.node.text;
      if (!text) continue;
      const quadruple = describeQuadruple(text);
      findings.push(
        slotFinding({
          ruleId: "unbound-text-style",
          severity: "fixable",
          node: slot.node,
          scope: "text",
          propPath: slot.propPath,
          currentValue: quadruple,
          message:
            `This text can't follow the type scale. ${quadruple} is set on the layer, ` +
            "so a change to the scale — or a different tenant's type — won't reach it.",
          occupiesSlot: true,
          detail: {
            fontFamily: text.fontFamily,
            fontSize: text.fontSize,
            fontWeight: text.fontWeight,
            lineHeight: text.lineHeight,
          },
        }),
      );
    }
    return findings;
  },

  propose(finding, ctx) {
    return proposeTextStyle(finding, ctx);
  },
};

function proposeTextStyle(finding: Finding, ctx: LintContext): Proposal | null {
  const text = readQuadruple(finding);
  if (!text) return noMatch(`this text (${finding.currentValue})`);

  const match = matchType(text, ctx.theme.types, ctx.breakpoint);
  if (!match) {
    return {
      kind: "none",
      reason: `No ${ctx.breakpoint} type style in this theme is ${finding.currentValue}.`,
      hint: "Either add the style to the theme's typography set, or restyle the layer to one that exists. Type is never near-matched — a rounded font size becomes a wrong token downstream.",
    };
  }

  const bindable = isBindable(match.winner);
  const style = match.style;
  const proposal: Proposal = {
    kind: "exact",
    tokenRef: match.winner.ref,
    confidence: 1,
    evidence: `${style.size}/${style.lineHeight} ${style.weight} ${style.family} === ${match.winner.ref}`,
    candidates: [
      {
        tokenRef: match.winner.ref,
        distance: 0,
        value: `${style.size}/${style.lineHeight} ${style.weight}`,
        bindable,
      },
    ],
    target: { type: "textStyle" },
    bindable,
  };
  if (!bindable) {
    proposal.unbindableReason =
      `${match.winner.ref} has no matching Figma text style in this file — ` +
      "text binds through a style, not a variable.";
  }
  return proposal;
}

/** The four values, read back off the finding rather than out of its label. */
function readQuadruple(finding: Finding):
  | { fontFamily: string; fontSize: number; fontWeight: string | number; lineHeight: number | "auto" }
  | null {
  const detail = finding.detail;
  if (!detail) return null;
  const { fontFamily, fontSize, fontWeight, lineHeight } = detail;
  if (typeof fontFamily !== "string" || typeof fontSize !== "number") return null;
  if (fontWeight === undefined) return null;
  const lh = lineHeight === "auto" ? ("auto" as const) : typeof lineHeight === "number" ? lineHeight : null;
  if (lh === null) return null;
  return { fontFamily, fontSize, fontWeight, lineHeight: lh };
}
