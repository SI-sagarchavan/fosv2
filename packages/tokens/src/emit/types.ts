/**
 * Part 5 — TypeScript emission.
 *
 * Emits nothing but `export type` aliases, which makes the output valid as
 * either a `.ts` module or a `.d.ts` declaration file. Runtime arrays of the
 * same refs are available from `createRegistry(theme).list(category)`, so
 * nothing here has to be duplicated as a value.
 *
 * This is the surface the DSL node schemas and the codegen agent's JSON Schema
 * derive from: if a ref is not in one of these unions, no downstream consumer
 * can emit it.
 */

import type { NormalizedTheme } from "../types.js";
import { compareTokenNames, typeIntersection } from "../normalize.js";
import type { SurfaceSet } from "../raw-schema.js";
import { DURATION_LEAVES, EASING_LEAVES } from "../motion.js";

export interface EmitTypesOptions {
  surfaces?: SurfaceSet;
  /**
   * Include `type.*` styles that are missing on some breakpoint. Off by
   * default — a partial style resolves at one viewport and vanishes at another,
   * and a union that admits it is lying to every consumer.
   */
  allowPartialTypography?: boolean;
}

interface UnionSpec {
  name: string;
  doc: string;
  refs: string[];
}

function renderUnion(spec: UnionSpec): string {
  const { name, doc, refs } = spec;
  const header = `/** ${doc} (${refs.length}) */`;
  if (refs.length === 0) return `${header}\nexport type ${name} = never;`;
  const members = refs.map((r) => `${"  "}| ${JSON.stringify(r)}`).join("\n");
  return `${header}\nexport type ${name} =\n${members};`;
}

export function tokenUnions(theme: NormalizedTheme, options: EmitTypesOptions = {}): UnionSpec[] {
  const sorted = (values: Iterable<string>, prefix: string) =>
    [...values].sort(compareTokenNames).map((leaf) => `${prefix}.${leaf}`);

  const typeKeys = options.allowPartialTypography
    ? [...new Set([...theme.type.mobile.keys(), ...theme.type.tablet.keys(), ...theme.type.desktop.keys()])]
    : typeIntersection(theme);

  return [
    { name: "SpaceToken", doc: "Spacing scale", refs: sorted(theme.space.keys(), "space") },
    { name: "RadiusToken", doc: "Corner radius scale", refs: sorted(theme.radius.keys(), "radius") },
    { name: "ColorToken", doc: "Colour palette", refs: sorted(theme.color.light.keys(), "color") },
    { name: "OpacityToken", doc: "Opacity scale", refs: sorted(theme.opacity.keys(), "opacity") },
    { name: "GradientToken", doc: "Gradients", refs: sorted(theme.gradient.light.keys(), "gradient") },
    { name: "ShadowToken", doc: "Shadows", refs: sorted(theme.shadow.light.keys(), "shadow") },
    {
      name: "TypeToken",
      doc: options.allowPartialTypography
        ? "Type styles — UNION across breakpoints; some do not resolve at every viewport"
        : "Type styles present on every breakpoint",
      refs: sorted(typeKeys, "type"),
    },
    {
      name: "SurfaceToken",
      doc: "Composite surfaces",
      refs: sorted(options.surfaces?.surfaces.keys() ?? [], "surface"),
    },
    {
      name: "DurationToken",
      doc: "Motion durations (built-in, not from the theme export)",
      refs: DURATION_LEAVES.map((l) => `duration.${l}`),
    },
    {
      name: "EasingToken",
      doc: "Motion easing curves (built-in, not from the theme export)",
      refs: EASING_LEAVES.map((l) => `easing.${l}`),
    },
    {
      name: "MotionToken",
      doc: "Motion policy flags",
      refs: ["motion.reducedPolicy"],
    },
  ];
}

export function emitTypes(theme: NormalizedTheme, options: EmitTypesOptions = {}): string {
  const unions = tokenUnions(theme, options);
  const out: string[] = [];

  out.push(`/* @fanos/tokens — ${theme.name} (${theme.id}) */`);
  out.push("/* Generated file. Do not edit. Regenerate with `fos-tokens types`. */");
  out.push("");
  for (const spec of unions) {
    out.push(renderUnion(spec));
    out.push("");
  }

  const present = unions.filter((u) => u.refs.length > 0).map((u) => u.name);
  out.push("/** Every canonical ref this theme can produce. */");
  if (present.length === 0) out.push("export type AnyToken = never;");
  else out.push(`export type AnyToken =\n${present.map((n) => `  | ${n}`).join("\n")};`);
  out.push("");

  return `${out.join("\n").trimEnd()}\n`;
}
