/**
 * Paint -> `surface.*`.
 *
 * A node's fill, stroke, radius and shadow are one visual thing in the DSL: a
 * surface token. The compiler cannot invent a good NAME for one — that is
 * genuinely a design-system decision — but it can do the two halves that are
 * decidable: recognise when the paint matches a surface the theme already has,
 * and describe precisely what a new one would need to contain.
 *
 * So an unmatched surface is not a failure. It is reported, with its spec, as
 * work for a human or a later pass. What the compiler will not do is silently
 * drop the paint, or silently invent a token that does not resolve.
 */

import type { FrameIRNode } from "@fanos/figma-ir-extractor/ir";
import type { NormalizedTheme, Surface, SurfaceSet } from "@fanos/tokens";
import { canonicalRef, paintRef } from "./refs.js";

export interface RequiredSurface {
  /** Suggested name, derived from the layer. Deterministic, not necessarily good. */
  name: string;
  spec: Surface;
  /** IR nodes that would use it. */
  srcs: string[];
}

/** Stable, order-insensitive identity for a surface spec. */
function fingerprint(s: Surface): string {
  return JSON.stringify({
    layers: (s.layers ?? []).map((l) => [l.type, "ref" in l ? l.ref : null]),
    borders: (s.borders ?? []).map((b) => [b.width, b.color, b.radius ?? null]),
    radius: s.radius ?? null,
    shadow: s.shadow ?? null,
  });
}

/**
 * Build the surface a node's paint describes, or undefined if it paints nothing.
 *
 * Returns undefined rather than an empty surface for an unpainted frame — a
 * layout container should not carry a `surface` prop it does not need.
 */
export function specOf(theme: NormalizedTheme, n: FrameIRNode): Surface | undefined {
  const spec: Surface = {};

  const fill = paintRef(theme, n.fill?.tokenRef);
  if (fill) spec.layers = [{ type: fill.kind, ref: fill.ref }];

  if (n.stroke) {
    const color = canonicalRef(theme, n.stroke.tokenRef, "color");
    const radius = canonicalRef(theme, n.radius?.tokenRef, "radius");
    if (color) {
      spec.borders = [
        { width: n.stroke.weight, color, ...(radius && radius !== "radius.none" ? { radius } : {}) },
      ];
    }
  }

  const radius = canonicalRef(theme, n.radius?.tokenRef, "radius");
  if (radius && radius !== "radius.none") spec.radius = radius;

  const shadow = n.effects
    .map((e) => canonicalRef(theme, e.tokenRef, "shadow"))
    .find((r): r is string => r !== undefined);
  if (shadow) spec.shadow = shadow;

  const empty =
    spec.layers === undefined &&
    spec.borders === undefined &&
    spec.radius === undefined &&
    spec.shadow === undefined;
  return empty ? undefined : spec;
}

/**
 * Resolve a spec to an existing surface name, or register it as required.
 *
 * Matching is on the spec's content, never its name: the same plate under two
 * different layer names is one surface, and two different plates that happen to
 * share a layer name are two.
 */
export class SurfaceResolver {
  private readonly existing = new Map<string, string>();
  private readonly required = new Map<string, RequiredSurface>();

  constructor(surfaces: SurfaceSet | undefined) {
    for (const [name, spec] of surfaces?.surfaces ?? new Map<string, Surface>()) {
      this.existing.set(fingerprint(spec), name);
    }
  }

  resolve(spec: Surface, suggestedName: string, src: string): string {
    const fp = fingerprint(spec);
    const hit = this.existing.get(fp);
    if (hit) return `surface.${hit}`;

    const already = this.required.get(fp);
    if (already) {
      already.srcs.push(src);
      return `surface.${already.name}`;
    }
    // Deterministic de-duplication of the suggested name, so a re-run produces
    // identical output.
    let name = suggestedName;
    const taken = new Set([...this.existing.values(), ...[...this.required.values()].map((r) => r.name)]);
    for (let i = 2; taken.has(name); i++) name = `${suggestedName}_${i}`;
    this.required.set(fp, { name, spec, srcs: [src] });
    return `surface.${name}`;
  }

  /** Surfaces the tree references that the theme does not yet define. */
  missing(): RequiredSurface[] {
    return [...this.required.values()];
  }
}
