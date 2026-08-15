/**
 * F6 — a shadow or blur set per-layer instead of through an effect style.
 *
 * PURE. No Figma import.
 *
 * IR 1.2.0 carries effect geometry, so a DROP_SHADOW / INNER_SHADOW can be
 * value-matched against `theme.shadows` and proposed as an effect style — the
 * same way F3 proposes a text style. Exact only: a near miss on offset or blur
 * is a different elevation.
 *
 * LAYER_BLUR / BACKGROUND_BLUR, and any 1.1.0 row with no geometry, still
 * report and do not propose. Guessing from the type alone would bind every
 * DROP_SHADOW on the page to whichever shadow token happens to exist.
 */
import { enumerateSlots } from "../health/slots.js";
import type { Finding, LintContext, Proposal, Rule } from "../health/types.js";
import { isBindable } from "../health/types.js";
import {
  fingerprintEffect,
  hasEffectGeometry,
  matchEffect,
  type EffectGeometry,
} from "../match/effect.js";
import { slotFinding } from "./shared.js";

export const unboundEffect: Rule = {
  id: "unbound-effect",
  code: "F6",
  severity: "fixable",
  protects: "the elevation scale — a per-layer shadow never receives a change to it",

  check(ir) {
    const findings: Finding[] = [];
    for (const slot of enumerateSlots(ir.root)) {
      if (slot.kind !== "effect" || slot.bound) continue;
      const effect = slot.node.effects[slot.effectIndex ?? 0];
      const type = slot.effectType ?? effect?.type ?? "EFFECT";
      const geo = geometryOf(effect);
      findings.push(
        slotFinding({
          ruleId: "unbound-effect",
          severity: "fixable",
          node: slot.node,
          scope: "effect",
          propPath: slot.propPath,
          currentValue: geo ? fingerprintEffect(geo) : label(type).replace(" ", "-"),
          message:
            `This ${label(type)} is set on the layer, so a change to the elevation scale ` +
            "won't reach it and a different tenant gets this exact shadow.",
          occupiesSlot: true,
          hint: geo
            ? undefined
            : "Bind it to an effect style. Shadows are composite values — Figma has no single variable for one.",
          detail: geo
            ? {
                effectType: type,
                x: geo.x,
                y: geo.y,
                blur: geo.blur,
                spread: geo.spread,
                color: geo.color,
                opacity: geo.opacity,
                inset: geo.inset ? 1 : 0,
              }
            : { effectType: type },
        }),
      );
    }
    return findings;
  },

  propose(finding, ctx) {
    return proposeEffect(finding, ctx);
  },
};

function proposeEffect(finding: Finding, ctx: LintContext): Proposal {
  const geo = geometryFromFinding(finding);
  if (!geo) {
    const authored = ctx.theme.shadows.filter((s) => s.binding !== undefined).length;
    return {
      kind: "none",
      reason:
        "Effect geometry isn't in this IR, so there's nothing to match a shadow token against.",
      hint:
        authored > 0
          ? `Apply one of the ${authored} effect styles in this file by hand — the panel can see they exist but can't tell which one this layer wants.`
          : "Author the theme's shadow tokens as Figma effect styles first; then they can be applied by name.",
    };
  }

  if (geo.type === "LAYER_BLUR" || geo.type === "BACKGROUND_BLUR") {
    return {
      kind: "none",
      reason: "A blur isn't an elevation token — there's nothing in the theme to bind it to.",
      hint: "Leave it, or replace it with a shadow token if this was meant to be elevation.",
    };
  }

  const match = matchEffect(geo, ctx.theme.shadows);
  if (!match) {
    return {
      kind: "none",
      reason: `No shadow token in this theme is ${finding.currentValue}.`,
      hint: "Either add the elevation to the theme, or restyle the layer to a shadow that exists. Shadows are never near-matched.",
    };
  }

  const bindable = isBindable(match.winner);
  const proposal: Proposal = {
    kind: "exact",
    tokenRef: match.winner.ref,
    confidence: 1,
    evidence: `${finding.currentValue} === ${match.winner.ref}`,
    candidates: [
      {
        tokenRef: match.winner.ref,
        distance: 0,
        value: match.winner.value,
        bindable,
      },
    ],
    target: { type: "effectStyle" },
    bindable,
  };
  if (!bindable) {
    proposal.unbindableReason =
      `${match.winner.ref} has no matching Figma effect style in this file — ` +
      "shadows bind through a style, not a variable.";
  }
  return proposal;
}

function geometryOf(effect: { type: string; x?: number; y?: number; blur?: number; spread?: number; color?: string; opacity?: number; inset?: boolean } | undefined): EffectGeometry | null {
  if (!effect) return null;
  const candidate = {
    type: effect.type,
    x: effect.x,
    y: effect.y,
    blur: effect.blur,
    spread: effect.spread,
    color: effect.color,
    opacity: effect.opacity,
    inset: effect.inset ?? effect.type === "INNER_SHADOW",
  };
  return hasEffectGeometry(candidate) ? candidate : null;
}

function geometryFromFinding(finding: Finding): EffectGeometry | null {
  const detail = finding.detail;
  if (!detail) return null;
  const type = typeof detail.effectType === "string" ? detail.effectType : "DROP_SHADOW";
  return geometryOf({
    type,
    x: typeof detail.x === "number" ? detail.x : undefined,
    y: typeof detail.y === "number" ? detail.y : undefined,
    blur: typeof detail.blur === "number" ? detail.blur : undefined,
    spread: typeof detail.spread === "number" ? detail.spread : undefined,
    color: typeof detail.color === "string" ? detail.color : undefined,
    opacity: typeof detail.opacity === "number" ? detail.opacity : undefined,
    inset: detail.inset === 1 || type === "INNER_SHADOW",
  });
}

function label(type: string): string {
  switch (type) {
    case "DROP_SHADOW":
      return "drop shadow";
    case "INNER_SHADOW":
      return "inner shadow";
    case "LAYER_BLUR":
      return "layer blur";
    case "BACKGROUND_BLUR":
      return "background blur";
    default:
      return "effect";
  }
}
