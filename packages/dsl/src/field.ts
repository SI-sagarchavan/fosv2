/**
 * The field descriptor language every consumer derives from.
 *
 * Five things need to agree about what a prop accepts: the Zod validator, the
 * agent's JSON Schema, the emitted `.d.ts`, the docs table, and the token-ref
 * walker. Hand-writing five of anything guarantees they drift, so each node's
 * props are declared ONCE as data and the five representations are computed.
 *
 * Pure. No I/O.
 */

import { z } from "zod";
import type { Category } from "@fanos/tokens";
import {
  ANCHORS,
  PERCENT_RE,
  RATIO_RE,
  SEMVER_REF_RE,
  SIGNED_TOKEN_REF_RE,
  TOKEN_REF_RE,
  type Anchor,
} from "./values.js";

/** `z.enum` wants a non-empty tuple; the list itself stays the one source. */
const ANCHOR_VALUES = ANCHORS as unknown as [Anchor, ...Anchor[]];

// ---------------------------------------------------------------------------
// Descriptors
// ---------------------------------------------------------------------------

/** Categories a `Val<>` may draw token refs from. Default is space. */
export type ValCategory = "space" | "duration";

export type FieldType =
  | { k: "string"; pattern?: RegExp }
  | { k: "number"; int?: boolean }
  | { k: "boolean" }
  | { k: "enum"; values: readonly string[] }
  | { k: "literals"; values: readonly (string | number | boolean)[] }
  | { k: "token"; category: Category }
  | { k: "val"; category: ValCategory }
  | { k: "size" }
  | { k: "offset" }
  | { k: "ratio" }
  | { k: "semverRef" }
  | { k: "anchor" }
  | { k: "action" }
  | { k: "predicate" }
  | { k: "opaque" }
  | { k: "array"; of: FieldType }
  | { k: "object"; fields: Fields }
  | { k: "union"; of: FieldType[] };

export interface Field {
  type: FieldType;
  optional?: boolean;
  /** Wrap in `Resp<>` — a bare value or a `{ base, md?, lg? }` object. */
  resp?: boolean;
  doc?: string;
}

export type Fields = Record<string, Field>;

/** Shorthand constructors, so node declarations read like a spec table. */
export const f = {
  str: (pattern?: RegExp): FieldType => (pattern ? { k: "string", pattern } : { k: "string" }),
  num: (int = false): FieldType => ({ k: "number", int }),
  bool: (): FieldType => ({ k: "boolean" }),
  enum: (...values: string[]): FieldType => ({ k: "enum", values }),
  literals: (...values: Array<string | number | boolean>): FieldType => ({ k: "literals", values }),
  token: (category: Category): FieldType => ({ k: "token", category }),
  /** Token-or-raw. Defaults to space; pass `"duration"` for revealDelay / autoplay. */
  val: (category: ValCategory = "space"): FieldType => ({ k: "val", category }),
  size: (): FieldType => ({ k: "size" }),
  offset: (): FieldType => ({ k: "offset" }),
  ratio: (): FieldType => ({ k: "ratio" }),
  semverRef: (): FieldType => ({ k: "semverRef" }),
  anchor: (): FieldType => ({ k: "anchor" }),
  action: (): FieldType => ({ k: "action" }),
  predicate: (): FieldType => ({ k: "predicate" }),
  opaque: (): FieldType => ({ k: "opaque" }),
  arr: (of: FieldType): FieldType => ({ k: "array", of }),
  obj: (fields: Fields): FieldType => ({ k: "object", fields }),
  union: (...of: FieldType[]): FieldType => ({ k: "union", of }),
};

/** `{ type, optional, resp, doc }` without the ceremony. */
export function field(type: FieldType, options: Omit<Field, "type"> = {}): Field {
  return { type, ...options };
}

export const opt = (type: FieldType, options: Omit<Field, "type" | "optional"> = {}): Field =>
  field(type, { ...options, optional: true });

export const req = (type: FieldType, options: Omit<Field, "type" | "optional"> = {}): Field => field(type, options);

// ---------------------------------------------------------------------------
// Named shapes — shared by every representation
// ---------------------------------------------------------------------------

/**
 * `Action` is not specified upstream, so it is defined here as a CLOSED union.
 * An open `Record<string, unknown>` would let the agent invent handler names
 * that no renderer implements, and the failure would surface at runtime in
 * production rather than in the validator.
 */
export const ACTION_KINDS = ["none", "navigate", "open", "submit", "custom"] as const;

export const actionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("navigate"), href: z.string(), external: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal("open"), target: z.string() }).strict(),
  z.object({ kind: z.literal("submit"), form: z.string().optional() }).strict(),
  z
    .object({ kind: z.literal("custom"), name: z.string(), params: z.record(z.unknown()).optional() })
    .strict(),
]);

export type Action = z.infer<typeof actionSchema>;

/**
 * `when` carries a predicate whose shape is a phase-2 concern. The schema is
 * present so trees round-trip and so the field is not invented ad hoc later,
 * but nothing validates its contents yet.
 */
export const predicateSchema = z.record(z.unknown());
export type Predicate = z.infer<typeof predicateSchema>;

export const rawSchema = z.object({ raw: z.unknown(), _unbound: z.literal(true) }).strict();
export const rawNumberSchema = z.object({ raw: z.number(), _unbound: z.literal(true) }).strict();

// ---------------------------------------------------------------------------
// Zod derivation
// ---------------------------------------------------------------------------

const tokenRefSchema = z.string().regex(TOKEN_REF_RE, "expected a token ref like `space.4`");
const signedTokenRefSchema = z.string().regex(SIGNED_TOKEN_REF_RE, "expected a token ref, optionally negated");
const percentSchema = z.string().regex(PERCENT_RE, "expected a percentage like `32%`");

function zodOfType(type: FieldType): z.ZodTypeAny {
  switch (type.k) {
    case "string":
      return type.pattern ? z.string().regex(type.pattern) : z.string();
    case "number":
      return type.int ? z.number().int() : z.number();
    case "boolean":
      return z.boolean();
    case "enum":
      return z.enum(type.values as [string, ...string[]]);
    case "literals":
      return z.union(
        type.values.map((v) => z.literal(v)) as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]],
      );
    // Category membership and resolution are the validator's job (T1/T5), not
    // the parser's — a shape error and an unresolvable ref need different
    // messages, and collapsing them into one Zod issue loses the suggestions.
    case "token":
      return tokenRefSchema;
    case "val":
      return z.union([tokenRefSchema, rawSchema]);
    case "size":
      return z.union([tokenRefSchema, rawSchema, percentSchema, z.literal("full"), z.literal("auto")]);
    case "offset":
      return z.union([signedTokenRefSchema, rawSchema, percentSchema]);
    case "ratio":
      return z.string().regex(RATIO_RE, "expected a ratio like `37/50`");
    case "semverRef":
      return z.string().regex(SEMVER_REF_RE, "expected `name@1.2.3`");
    case "anchor":
      return z.enum(ANCHOR_VALUES);
    case "action":
      return actionSchema;
    case "predicate":
      return predicateSchema;
    case "opaque":
      return z.record(z.unknown());
    case "array":
      return z.array(zodOfType(type.of));
    case "object":
      return zodOfFields(type.fields);
    case "union":
      return z.union(type.of.map(zodOfType) as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }
}

/** Breakpoint keys come from the tokens package; T4 checks them against it too. */
export function zodOfField(fieldDef: Field, breakpointKeys: readonly string[]): z.ZodTypeAny {
  const inner = zodOfType(fieldDef.type);
  let schema: z.ZodTypeAny = inner;
  if (fieldDef.resp) {
    const shape: Record<string, z.ZodTypeAny> = { base: inner };
    for (const key of breakpointKeys) shape[key] = inner.optional();
    schema = z.union([inner, z.object(shape).strict()]);
  }
  return fieldDef.optional ? schema.optional() : schema;
}

export function zodOfFields(fields: Fields, breakpointKeys: readonly string[] = ["md", "lg"]): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, fieldDef] of Object.entries(fields)) shape[name] = zodOfField(fieldDef, breakpointKeys);
  return z.object(shape).strict();
}

// ---------------------------------------------------------------------------
// TypeScript derivation
// ---------------------------------------------------------------------------

const TOKEN_TS: Readonly<Record<Category, string>> = {
  space: "SpaceToken",
  radius: "RadiusToken",
  color: "ColorToken",
  opacity: "OpacityToken",
  gradient: "GradientToken",
  shadow: "ShadowToken",
  type: "TypeToken",
  surface: "SurfaceToken",
  asset: "AssetToken",
  duration: "DurationToken",
  easing: "EasingToken",
  motion: "MotionToken",
};

export function tsOfType(type: FieldType): string {
  switch (type.k) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "enum":
      return type.values.map((v) => JSON.stringify(v)).join(" | ");
    case "literals":
      return type.values.map((v) => (typeof v === "string" ? JSON.stringify(v) : String(v))).join(" | ");
    case "token":
      return TOKEN_TS[type.category];
    case "val":
      // Category-scoped: duration vals accept DurationToken, not any TokenRef.
      return type.category === "duration" ? "DurationToken | Raw<number>" : "Val<number>";
    case "size":
      return "SizeValue";
    case "offset":
      return "OffsetValue";
    case "ratio":
      return "`${number}/${number}`";
    case "semverRef":
      return "`${string}@${string}`";
    case "anchor":
      return "Anchor";
    case "action":
      return "Action";
    case "predicate":
      return "Predicate";
    case "opaque":
      return "Record<string, unknown>";
    case "array":
      return `Array<${tsOfType(type.of)}>`;
    case "object":
      return `{ ${Object.entries(type.fields)
        .map(([name, def]) => `${name}${def.optional ? "?" : ""}: ${tsOfField(def)}`)
        .join("; ")} }`;
    case "union":
      return type.of.map(tsOfType).join(" | ");
  }
}

export function tsOfField(fieldDef: Field): string {
  const inner = tsOfType(fieldDef.type);
  if (!fieldDef.resp) return inner;
  // Parenthesised so `Resp<A | B>` never reads as `Resp<A> | B`.
  return `Resp<${inner.includes("|") ? inner : inner}>`;
}

// ---------------------------------------------------------------------------
// JSON Schema derivation
// ---------------------------------------------------------------------------

export type JsonSchema = Record<string, unknown>;

export interface JsonContext {
  /** Category -> the theme's actual refs, so every token prop is a CLOSED enum. */
  tokensByCategory: Map<Category, string[]>;
  /** Populated as types are referenced; emitted as `$defs`. */
  defs: Map<string, JsonSchema>;
  breakpointKeys: readonly string[];
}

function defineOnce(ctx: JsonContext, name: string, build: () => JsonSchema): JsonSchema {
  if (!ctx.defs.has(name)) {
    // Reserve the slot before building so a def that references another def
    // cannot recurse into itself.
    ctx.defs.set(name, {});
    ctx.defs.set(name, build());
  }
  return { $ref: `#/$defs/${name}` };
}

function tokenDef(ctx: JsonContext, category: Category, signed = false): JsonSchema {
  const name = `${TOKEN_TS[category]}${signed ? "Negated" : ""}`;
  return defineOnce(ctx, name, () => {
    const refs = ctx.tokensByCategory.get(category) ?? [];
    const values = signed ? refs.flatMap((r) => [r, `-${r}`]) : refs;
    // A closed enum is the whole point: the agent physically cannot emit a ref
    // this theme does not have.
    return values.length > 0 ? { type: "string", enum: values } : { type: "string", enum: [] };
  });
}

function rawDef(ctx: JsonContext): JsonSchema {
  return defineOnce(ctx, "RawNumber", () => ({
    type: "object",
    properties: { raw: { type: "number" }, _unbound: { const: true } },
    required: ["raw", "_unbound"],
    additionalProperties: false,
  }));
}

function jsonOfType(type: FieldType, ctx: JsonContext): JsonSchema {
  switch (type.k) {
    case "string":
      return type.pattern ? { type: "string", pattern: type.pattern.source } : { type: "string" };
    case "number":
      return type.int ? { type: "integer" } : { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "enum":
      return { type: "string", enum: [...type.values] };
    case "literals":
      return { enum: [...type.values] };
    case "token":
      return tokenDef(ctx, type.category);
    case "val": {
      const cat = type.category;
      const defName = cat === "duration" ? "ValDuration" : "ValNumber";
      return defineOnce(ctx, defName, () => ({
        anyOf: [
          { type: "string", enum: ctx.tokensByCategory.get(cat) ?? [] },
          rawDef(ctx),
        ],
      }));
    }
    case "size":
      return defineOnce(ctx, "SizeValue", () => ({
        anyOf: [
          tokenDef(ctx, "space"),
          rawDef(ctx),
          { type: "string", pattern: PERCENT_RE.source },
          { const: "full" },
          { const: "auto" },
        ],
      }));
    case "offset":
      return defineOnce(ctx, "OffsetValue", () => ({
        anyOf: [tokenDef(ctx, "space", true), rawDef(ctx), { type: "string", pattern: PERCENT_RE.source }],
      }));
    case "ratio":
      return { type: "string", pattern: RATIO_RE.source };
    case "semverRef":
      return { type: "string", pattern: SEMVER_REF_RE.source };
    case "anchor":
      return defineOnce(ctx, "Anchor", () => ({
        type: "string",
        enum: [...ANCHORS],
      }));
    case "action":
      return defineOnce(ctx, "Action", () => ({
        anyOf: [
          closed({ kind: { const: "none" } }, ["kind"]),
          closed({ kind: { const: "navigate" }, href: { type: "string" }, external: { type: "boolean" } }, [
            "kind",
            "href",
          ]),
          closed({ kind: { const: "open" }, target: { type: "string" } }, ["kind", "target"]),
          closed({ kind: { const: "submit" }, form: { type: "string" } }, ["kind"]),
          closed({ kind: { const: "custom" }, name: { type: "string" }, params: { type: "object" } }, [
            "kind",
            "name",
          ]),
        ],
      }));
    // Phase 2. Present so trees round-trip; deliberately unconstrained.
    case "predicate":
      return { type: "object" };
    case "opaque":
      return { type: "object" };
    case "array":
      return { type: "array", items: jsonOfType(type.of, ctx) };
    case "object":
      return jsonOfFields(type.fields, ctx);
    case "union":
      return { anyOf: type.of.map((t) => jsonOfType(t, ctx)) };
  }
}

function closed(properties: Record<string, JsonSchema>, required: string[]): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

export function jsonOfField(fieldDef: Field, ctx: JsonContext): JsonSchema {
  const inner = jsonOfType(fieldDef.type, ctx);
  if (!fieldDef.resp) return inner;
  const properties: Record<string, JsonSchema> = { base: inner };
  for (const key of ctx.breakpointKeys) properties[key] = inner;
  return { anyOf: [inner, closed(properties, ["base"])] };
}

export function jsonOfFields(fields: Fields, ctx: JsonContext): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [name, def] of Object.entries(fields)) {
    properties[name] = jsonOfField(def, ctx);
    if (!def.optional) required.push(name);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

// ---------------------------------------------------------------------------
// Docs derivation
// ---------------------------------------------------------------------------

export function docTypeOf(fieldDef: Field): string {
  const inner = tsOfType(fieldDef.type);
  return fieldDef.resp ? `Resp<${inner}>` : inner;
}
