/**
 * Part 7 — JSON Schema emission: the agent's structured-output contract.
 *
 * Three properties are non-negotiable and each is asserted by a test:
 *
 *  - NO recursion. Nothing `$ref`s itself, directly or through a chain. The wire
 *    format is flat precisely so this schema can be too, because recursive
 *    schemas are the single biggest cause of structured-output failures.
 *  - Closed enums everywhere. Token props enumerate the theme's ACTUAL refs, so
 *    the agent physically cannot emit a ref this tenant does not have.
 *  - `additionalProperties: false` on every object, so a hallucinated prop fails
 *    at generation rather than silently reaching a renderer.
 *
 * Size is the fourth concern. The full vocabulary is large; `subset` narrows it
 * to the node types a section subagent plausibly needs.
 */

import type { Category, Registry } from "@fanos/tokens";
import { CATEGORIES, DEFAULT_BREAKPOINTS } from "@fanos/tokens";
import { jsonOfFields, type JsonContext, type JsonSchema } from "../field.js";
import { allFields, NODE_SPECS, nodeSpec } from "../nodes/index.js";
import { SCHEMA_VERSION } from "../version.js";

export interface EmitJsonSchemaOptions {
  registry: Registry;
  /** Node types to include. Omit for the whole vocabulary. */
  subset?: readonly string[];
  breakpointKeys?: readonly string[];
  $id?: string;
}

export function emitJsonSchema(options: EmitJsonSchemaOptions): JsonSchema {
  const { registry, subset } = options;
  const breakpointKeys = options.breakpointKeys ?? Object.keys(DEFAULT_BREAKPOINTS);

  const specs = subset ? subset.map((t) => nodeSpec(t)).filter((s): s is NonNullable<typeof s> => Boolean(s)) : NODE_SPECS;
  if (specs.length === 0) throw new Error("emitJsonSchema: subset matched no known node types");

  const tokensByCategory = new Map<Category, string[]>();
  for (const category of CATEGORIES) tokensByCategory.set(category, registry.list(category));

  const ctx: JsonContext = { tokensByCategory, defs: new Map(), breakpointKeys };

  const nodeSchemas: JsonSchema[] = specs.map((spec) => ({
    type: "object",
    title: spec.type,
    description: spec.doc,
    properties: {
      id: { type: "string", minLength: 1 },
      parent: { type: ["string", "null"] },
      idx: { type: "integer", minimum: 0 },
      type: { const: spec.type },
      src: { type: "string", minLength: 1 },
      props: jsonOfFields(allFields(spec), ctx),
    },
    required: ["id", "parent", "idx", "type", "src", "props"],
    additionalProperties: false,
  }));

  const defs: Record<string, JsonSchema> = {};
  for (const name of [...ctx.defs.keys()].sort()) defs[name] = ctx.defs.get(name)!;

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: options.$id ?? `https://fanos.dev/schemas/dsl/${SCHEMA_VERSION}.json`,
    title: "FanOS SDUI flat tree",
    description:
      "A flat node list. Emit every node with its parent id and index; never nest. `src` is the Figma node id and is mandatory on every node.",
    type: "object",
    properties: {
      schemaVersion: { const: SCHEMA_VERSION },
      nodes: {
        type: "array",
        minItems: 1,
        items: { anyOf: nodeSchemas },
      },
    },
    required: ["schemaVersion", "nodes"],
    additionalProperties: false,
    $defs: defs,
  };
}

/**
 * Every `$ref` in the document, with the JSON pointer that reached it. Used by
 * the no-recursion test and worth keeping public — a consumer bundling this
 * schema needs the same guarantee.
 */
export function collectRefs(schema: unknown, at = "#"): Array<{ at: string; ref: string }> {
  const out: Array<{ at: string; ref: string }> = [];
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}/${i}`));
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, inner] of Object.entries(value)) {
      if (key === "$ref" && typeof inner === "string") out.push({ at: path, ref: inner });
      else walk(inner, `${path}/${key}`);
    }
  };
  walk(schema, at);
  return out;
}

/**
 * Names of `$defs` that reach themselves through any chain of `$ref`s.
 * Empty is the only acceptable answer.
 */
export function selfReferentialDefs(schema: JsonSchema): string[] {
  const defs = (schema["$defs"] ?? {}) as Record<string, JsonSchema>;
  const edges = new Map<string, string[]>();
  for (const [name, def] of Object.entries(defs)) {
    edges.set(
      name,
      collectRefs(def).map((r) => r.ref.replace("#/$defs/", "")),
    );
  }

  const offenders: string[] = [];
  for (const start of edges.keys()) {
    const stack = [...(edges.get(start) ?? [])];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (next === start) {
        offenders.push(start);
        break;
      }
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...(edges.get(next) ?? []));
    }
  }
  return offenders.sort();
}
