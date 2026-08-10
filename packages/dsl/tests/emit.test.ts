import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { collectRefs, emitJsonSchema, selfReferentialDefs } from "../src/emit/json-schema.js";
import { emitTypes } from "../src/emit/types.js";
import { emitDocs } from "../src/emit/docs.js";
import { NODE_TYPES } from "../src/nodes/index.js";
import { card, registry } from "./helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKENS_SRC = resolve(HERE, "../../tokens/src/index.ts");

const CARD_SUBSET = ["Box", "Stack", "Text", "Image", "Overlay", "Divider", "Icon"];

function schema(subset?: string[]) {
  return emitJsonSchema({ registry: registry(), ...(subset ? { subset } : {}) });
}

function ajv() {
  // strict:false — the schema carries `title`/`description` on subschemas, which
  // strict mode flags as unknown siblings.
  return new Ajv2020({ strict: false, allErrors: true });
}

describe("emitTypes", () => {
  const out = emitTypes();

  it("declares a node interface and a props interface for every node type", () => {
    for (const type of NODE_TYPES) {
      expect(out, type).toContain(`export interface ${type}Props`);
      expect(out, type).toContain(`export interface ${type}Node extends NodeEnvelope`);
    }
  });

  it("discriminates DslNode on `type`", () => {
    expect(out).toContain("export type DslNode =");
    for (const type of NODE_TYPES) expect(out).toContain(`  | ${type}Node`);
  });

  it("IMPORTS token unions rather than regenerating them", () => {
    // A second copy of the palette is a second thing to keep in step.
    expect(out).toContain('from "@fanos/tokens"');
    expect(out).toContain("  SpaceToken,");
    expect(out).not.toContain('"color.core_sec_500"');
  });

  it("makes Resp<TypeToken> a type error", () => {
    expect(out).toContain("export type Resp<T> = [T] extends [TypeToken] ? never : T | RespObject<T>;");
  });

  it("gives Text.style a bare TypeToken, never a Resp", () => {
    const block = out.slice(out.indexOf("export interface TextProps"), out.indexOf("export interface RichTextProps"));
    expect(block).toContain("style: TypeToken;");
    expect(block).not.toContain("style: Resp<");
  });

  it("drops the universal layout props from the Repeater fragment", () => {
    const block = out.slice(out.indexOf("export interface RepeaterProps"), out.indexOf("export interface CustomProps"));
    expect(block).not.toContain("surface?:");
    expect(block).not.toContain("place?:");
    expect(block).toContain("over: string;");
  });

  it("compiles under strict mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "fos-dsl-types-"));
    const file = join(dir, "nodes.d.ts");
    writeFileSync(file, out, "utf8");

    const program = ts.createProgram([file], {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      baseUrl: dir,
      paths: { "@fanos/tokens": [TOKENS_SRC] },
    });
    const messages = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.file?.fileName === file.replace(/\\/g, "/"))
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
    expect(messages).toEqual([]);
  });

  it("is byte-identical across two runs", () => {
    expect(emitTypes()).toBe(emitTypes());
  });
});

describe("emitJsonSchema", () => {
  it("has NO self-referential $defs", () => {
    // Recursive schemas are the single biggest cause of structured-output
    // failures; the flat wire format exists so this schema can be flat too.
    expect(selfReferentialDefs(schema())).toEqual([]);
  });

  it("resolves every $ref to a $def that exists", () => {
    const s = schema();
    const defs = Object.keys((s["$defs"] ?? {}) as Record<string, unknown>);
    for (const { ref } of collectRefs(s)) {
      expect(ref.startsWith("#/$defs/")).toBe(true);
      expect(defs).toContain(ref.replace("#/$defs/", ""));
    }
  });

  it("passes draft-2020-12 meta-validation", () => {
    expect(ajv().validateSchema(schema())).toBe(true);
  });

  it("closes every object", () => {
    const open: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${path}/${i}`));
      if (typeof value !== "object" || value === null) return;
      const node = value as Record<string, unknown>;
      if (node["type"] === "object" && node["properties"] && node["additionalProperties"] !== false) {
        open.push(path);
      }
      for (const [k, v] of Object.entries(node)) if (k !== "$defs") walk(v, `${path}/${k}`);
    };
    // `Predicate` and `Custom.props` are deliberately opaque (phase 2 / opaque
    // rendering) and carry no `properties`, so they are not caught here.
    walk(schema(), "#");
    expect(open).toEqual([]);
  });

  it("emits token props as CLOSED enums of this theme's actual refs", () => {
    const defs = schema()["$defs"] as Record<string, { enum?: string[] }>;
    expect(defs["ColorToken"]?.enum).toHaveLength(163);
    expect(defs["ColorToken"]?.enum).toContain("color.core_sec_500");
    expect(defs["SurfaceToken"]?.enum).toContain("surface.card_player");
    // 30 breakpoint-complete styles — the partial ones are not emittable.
    expect(defs["TypeToken"]?.enum).toHaveLength(30);
    expect(defs["TypeToken"]?.enum).not.toContain("type.xl_medium");
  });

  it("offers negated space refs for offsets, since a badge can hang off an edge", () => {
    const defs = schema()["$defs"] as Record<string, { enum?: string[] }>;
    expect(defs["SpaceTokenNegated"]?.enum).toContain("-space.6");
    expect(defs["SpaceTokenNegated"]?.enum).toContain("space.6");
  });

  it("validates the card fixture", () => {
    const validateFn = ajv().compile(schema());
    const ok = validateFn(card());
    if (!ok) console.error(validateFn.errors);
    expect(ok).toBe(true);
  });

  it("rejects a node type outside the vocabulary", () => {
    const validateFn = ajv().compile(schema());
    const tree = card();
    tree.nodes[1]!.type = "Marquee";
    expect(validateFn(tree)).toBe(false);
  });

  it("rejects a token ref this theme does not have", () => {
    const validateFn = ajv().compile(schema());
    const tree = card();
    tree.nodes[0]!.props["surface"] = "surface.nope";
    expect(validateFn(tree)).toBe(false);
  });
});

describe("emitJsonSchema — subset", () => {
  it("is materially smaller", () => {
    const full = JSON.stringify(schema()).length;
    const small = JSON.stringify(schema(CARD_SUBSET)).length;
    expect(small).toBeLessThan(full * 0.75);
  });

  it("still validates the card fixture", () => {
    const validateFn = ajv().compile(schema(CARD_SUBSET));
    const ok = validateFn(card());
    if (!ok) console.error(validateFn.errors);
    expect(ok).toBe(true);
  });

  it("still meta-validates and stays non-recursive", () => {
    expect(ajv().validateSchema(schema(CARD_SUBSET))).toBe(true);
    expect(selfReferentialDefs(schema(CARD_SUBSET))).toEqual([]);
  });

  it("rejects a node type outside the subset", () => {
    const validateFn = ajv().compile(schema(CARD_SUBSET));
    const tree = card();
    tree.nodes.push({
      id: "extra",
      parent: "card",
      idx: 4,
      type: "Countdown",
      src: "1:7000",
      props: { to: "2026-01-01T00:00:00Z", units: ["d", "h"], place: { anchor: "center" } },
    });
    expect(validateFn(tree)).toBe(false);
  });

  it("throws rather than emitting an empty vocabulary", () => {
    expect(() => schema(["Nonsense"])).toThrow(/matched no known node types/);
  });
});

describe("emitDocs", () => {
  const docs = emitDocs();

  it("documents every node type", () => {
    for (const type of NODE_TYPES) expect(docs, type).toContain(`### ${type}`);
  });

  it("documents the universal props once, not per node", () => {
    expect(docs).toContain("## Universal props");
    expect(docs.match(/## Universal props/g)).toHaveLength(1);
  });

  it("marks the Repeater as a fragment", () => {
    expect(docs).toContain("**Fragment.**");
  });

  it("is byte-identical across two runs", () => {
    expect(emitDocs()).toBe(emitDocs());
  });
});
