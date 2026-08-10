/**
 * Part 7 — TypeScript emission.
 *
 * A discriminated union on `type`, one prop interface per node, and the shared
 * value shapes. This is what the renderer's prop types and Surface Admin's form
 * controls compile against.
 *
 * Token unions are IMPORTED from `@fanos/tokens`, never regenerated here — a
 * second copy of the palette is a second thing to keep in step, which is the
 * exact failure this package exists to prevent.
 */

import { tsOfField, type Fields } from "../field.js";
import { NODE_SPECS, allFields } from "../nodes/index.js";
import { SCHEMA_VERSION } from "../version.js";

const TOKEN_IMPORTS = [
  "AssetToken",
  "ColorToken",
  "DurationToken",
  "EasingToken",
  "GradientToken",
  "MotionToken",
  "OpacityToken",
  "RadiusToken",
  "ShadowToken",
  "SpaceToken",
  "SurfaceToken",
  "TypeToken",
];

function propsInterface(name: string, fields: Fields, doc: string, extendsFrom?: string): string {
  const lines: string[] = [];
  lines.push(`/** ${doc} */`);
  lines.push(`export interface ${name}${extendsFrom ? ` extends ${extendsFrom}` : ""} {`);
  for (const [prop, def] of Object.entries(fields)) {
    if (def.doc) lines.push(`  /** ${def.doc} */`);
    lines.push(`  ${prop}${def.optional ? "?" : ""}: ${tsOfField(def)};`);
  }
  lines.push("}");
  return lines.join("\n");
}

export function emitTypes(): string {
  const out: string[] = [];

  out.push("/* @fanos/dsl — SDUI node types */");
  out.push("/* Generated file. Do not edit. Regenerate with `fos-dsl types`. */");
  out.push("");
  out.push(`import type {\n${TOKEN_IMPORTS.map((t) => `  ${t},`).join("\n")}\n} from "@fanos/tokens";`);
  out.push("");

  out.push("// --- value wrappers -------------------------------------------------------");
  out.push("");
  out.push("/** A value with no token yet. Validates, but is counted as design-ops debt. */");
  out.push("export interface Raw<T> {\n  raw: T;\n  _unbound: true;\n}");
  out.push("");
  out.push("export type TokenRef = `${string}.${string}`;");
  out.push("export type Val<T> = TokenRef | Raw<T>;");
  out.push("");
  out.push("/** Breakpoint keys mirror the tokens package config. */");
  out.push("export type RespObject<T> = { base: T; md?: T; lg?: T };");
  out.push("");
  out.push("/**");
  out.push(" * `Resp<TypeToken>` is deliberately `never`: type tokens already resolve per");
  out.push(" * breakpoint inside @fanos/tokens, so wrapping one creates two competing");
  out.push(" * responsive systems for a single value. Rule T3 catches it at runtime.");
  out.push(" */");
  out.push("export type Resp<T> = [T] extends [TypeToken] ? never : T | RespObject<T>;");
  out.push("");
  out.push("export type Percent = `${number}%`;");
  out.push('export type SizeValue = SpaceToken | Raw<number> | Percent | "full" | "auto";');
  out.push("export type OffsetValue = SpaceToken | `-${SpaceToken}` | Raw<number> | Percent;");
  out.push("");
  out.push(
    [
      "export type Anchor =",
      '  | "fill"',
      '  | "top-start"',
      '  | "top-center"',
      '  | "top-end"',
      '  | "mid-start"',
      '  | "center"',
      '  | "mid-end"',
      '  | "bottom-start"',
      '  | "bottom-center"',
      '  | "bottom-end";',
    ].join("\n"),
  );
  out.push("");
  out.push(
    [
      "export type Action =",
      '  | { kind: "none" }',
      '  | { kind: "navigate"; href: string; external?: boolean }',
      '  | { kind: "open"; target: string }',
      '  | { kind: "submit"; form?: string }',
      '  | { kind: "custom"; name: string; params?: Record<string, unknown> };',
    ].join("\n"),
  );
  out.push("");
  out.push("/** Phase 2 — present so trees round-trip; contents are not validated yet. */");
  out.push("export type Predicate = Record<string, unknown>;");
  out.push("");

  out.push("// --- universal props ------------------------------------------------------");
  out.push("");
  // Emitted from Box's field set, which is the universal set and nothing else.
  const universal = allFields({ type: "Box", kind: "structural", doc: "", fields: {} });
  out.push(propsInterface("UniversalProps", universal, "Carried by every node type."));
  out.push("");

  out.push("// --- node props -----------------------------------------------------------");
  for (const spec of NODE_SPECS) {
    out.push("");
    // Fragments drop the universal layout props, so they extend nothing and
    // declare their reduced surface in full.
    if (spec.fragment) {
      out.push(propsInterface(`${spec.type}Props`, allFields(spec), spec.doc));
    } else {
      out.push(propsInterface(`${spec.type}Props`, spec.fields, spec.doc, "UniversalProps"));
    }
  }
  out.push("");

  out.push("// --- nodes ----------------------------------------------------------------");
  out.push("");
  out.push("interface NodeEnvelope {\n  id: string;\n  parent: string | null;\n  idx: number;\n  /** Figma node id, or `synthetic:<parentSrc>:<n>`. Mandatory. */\n  src: string;\n}");
  for (const spec of NODE_SPECS) {
    out.push("");
    out.push(
      `export interface ${spec.type}Node extends NodeEnvelope {\n  type: ${JSON.stringify(spec.type)};\n  props: ${spec.type}Props;\n}`,
    );
  }
  out.push("");
  out.push("/** Discriminated on `type`. */");
  out.push(`export type DslNode =\n${NODE_SPECS.map((s) => `  | ${s.type}Node`).join("\n")};`);
  out.push("");
  out.push(`export type NodeType = DslNode["type"];`);
  out.push("");
  out.push("/** The wire format. Flat by design — the agent never emits nesting. */");
  out.push(
    `export interface FlatTree {\n  schemaVersion: ${JSON.stringify(SCHEMA_VERSION)} | (string & {});\n  nodes: DslNode[];\n}`,
  );
  out.push("");

  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
