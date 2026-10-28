/**
 * Bindings against the data they will meet — the B rules.
 *
 * The S and T rules check a tree against the vocabulary and the theme. These
 * check it against a DATA SAMPLE: every `{path}`, every `Repeater.over`, every
 * `when` must name something the payload has, in a shape that slot can draw.
 *
 * Why it has to be static: a wrong path is schema-legal and geometry-neutral.
 * `{article.headline}` against a CMS Listing payload (whose field is `title`)
 * validates, conforms, and renders the literal braces onto the page. The
 * renderer can only warn after the fact; an agent repairing the tree needs to
 * hear it before, with the fields it COULD have used.
 *
 * THE SAMPLE IS THE CONTRACT, until CAST hands us the hook's output schema.
 * Every item of every list is merged, so a field that is null on the first
 * article and set on the third is known, and known to be nullable. A field no
 * sampled item carries is invisible to this — B1 on it may be a short sample,
 * not a wrong tree.
 *
 *   B1  path not in the data
 *   B2  wrong shape for the slot (an object drawn as text, `over` not a list)
 *   B3  path walks through a numeric page key (`data.1`) — bind `items`
 *   B4  unknown pipe, wrong arity, or `date` on a value that is not a date
 *   B5  an ISO date drawn without `date` — it will print `2026-10-21T10:29:00.000Z`
 *   B6  image URL has the CDN `{{RATIO}}` slot and the Image has no (servable) ratio
 *   B7  `when` compares against a value of a type the field never holds
 *
 * PURE.
 */

import type { FlatNode, FlatTree } from "./flat.js";
import type { Issue } from "./validate.js";
import {
  CDN_RATIOS,
  conditionsOf,
  parseRefs,
  PIPES,
  predicateSchema,
  RATIO_SLOT,
  type Ref,
} from "./binding.js";

// ---------------------------------------------------------------------------
// Shape inference
// ---------------------------------------------------------------------------

type ScalarType = "string" | "number" | "boolean" | "null";

export type Shape =
  | { kind: "scalar"; types: Set<ScalarType>; isoDate: boolean; ratioSlot: boolean }
  | { kind: "object"; fields: Map<string, Shape>; nullable: boolean }
  | { kind: "array"; of: Shape | null; nullable: boolean };

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** The merged shape of a sample. Arrays merge every element. */
export function inferShape(value: unknown): Shape {
  if (Array.isArray(value)) {
    let of: Shape | null = null;
    for (const el of value) of = of ? mergeShape(of, inferShape(el)) : inferShape(el);
    return { kind: "array", of, nullable: false };
  }
  if (value !== null && typeof value === "object") {
    const fields = new Map<string, Shape>();
    for (const [k, v] of Object.entries(value)) fields.set(k, inferShape(v));
    return { kind: "object", fields, nullable: false };
  }
  const t: ScalarType = value === null ? "null" : (typeof value as ScalarType);
  return {
    kind: "scalar",
    types: new Set([t]),
    isoDate: typeof value === "string" && ISO_DATE_RE.test(value),
    ratioSlot: typeof value === "string" && value.includes(RATIO_SLOT),
  };
}

function mergeShape(a: Shape, b: Shape): Shape {
  // `null` beside a structure is a nullable structure, not a type conflict.
  if (isNullScalar(a) && b.kind !== "scalar") return { ...b, nullable: true };
  if (isNullScalar(b) && a.kind !== "scalar") return { ...a, nullable: true };

  if (a.kind === "scalar" && b.kind === "scalar") {
    const types = new Set([...a.types, ...b.types]);
    // A date column stays a date column through its nulls.
    const isoDate = (a.isoDate || isNullScalar(a)) && (b.isoDate || isNullScalar(b)) && (a.isoDate || b.isoDate);
    return { kind: "scalar", types, isoDate, ratioSlot: a.ratioSlot || b.ratioSlot };
  }
  if (a.kind === "object" && b.kind === "object") {
    const fields = new Map(a.fields);
    for (const [k, v] of b.fields) fields.set(k, fields.has(k) ? mergeShape(fields.get(k)!, v) : v);
    return { kind: "object", fields, nullable: a.nullable || b.nullable };
  }
  if (a.kind === "array" && b.kind === "array") {
    const of = a.of && b.of ? mergeShape(a.of, b.of) : (a.of ?? b.of);
    return { kind: "array", of, nullable: a.nullable || b.nullable };
  }
  return a; // genuinely mixed; keep the first and let the checks speak for it
}

const isNullScalar = (s: Shape): boolean => s.kind === "scalar" && s.types.size === 1 && s.types.has("null");

type Walk =
  | { ok: true; shape: Shape; pageKey?: string }
  | { ok: false; at: string; parent: Shape | null; pageKey?: string };

/** Follow a dotted path through a shape, remembering where it stopped. */
function walkShape(scope: Shape, path: string): Walk {
  let cur: Shape = scope;
  let pageKey: string | undefined;
  const parts = path.split(".");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const at = parts.slice(0, i + 1).join(".");
    if (cur.kind === "array" && /^\d+$/.test(part)) {
      if (!cur.of) return { ok: false, at, parent: cur, ...(pageKey ? { pageKey } : {}) };
      cur = cur.of;
      continue;
    }
    if (cur.kind !== "object") return { ok: false, at, parent: cur, ...(pageKey ? { pageKey } : {}) };
    const next = cur.fields.get(part);
    if (/^\d+$/.test(part) && next?.kind === "array") pageKey ??= at;
    if (!next) return { ok: false, at, parent: cur, ...(pageKey ? { pageKey } : {}) };
    cur = next;
  }
  return { ok: true, shape: cur, ...(pageKey ? { pageKey } : {}) };
}

/**
 * What an object offers, for the B1 message — the menu the agent picks from.
 *
 * All of it, up to a generous cap. A CMS Listing item has 21 fields and `title`
 * is the 14th, so a short menu hides exactly the field a `{headline}` binding
 * was reaching for.
 */
const MENU_MAX = 40;
function offered(shape: Shape | null): string {
  if (!shape || shape.kind !== "object") return "";
  const keys = [...shape.fields.keys()];
  const shown = keys.slice(0, MENU_MAX).join(", ");
  return ` — it has ${shown}${keys.length > MENU_MAX ? `, … (${keys.length} fields)` : ""}`;
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/** Every string in a props bag that carries a ref, with its dotted prop path. */
function templatesIn(props: Record<string, unknown>): Array<{ prop: string; value: string }> {
  const out: Array<{ prop: string; value: string }> = [];
  const walk = (v: unknown, path: string): void => {
    if (typeof v === "string") {
      if (v.includes("{")) out.push({ prop: path, value: v });
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}.${i}`));
    } else if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
    }
  };
  for (const [k, v] of Object.entries(props)) {
    // `when` and `over` are paths, not templates — checked on their own below.
    if (k === "_meta" || k === "when") continue;
    walk(v, k);
  }
  return out;
}

/** Pipe checks need no data, so they run on every validate. */
export function checkPipes(tree: FlatTree): Issue[] {
  const issues: Issue[] = [];
  for (const node of tree.nodes) {
    for (const t of templatesIn(node.props)) {
      for (const ref of parseRefs(t.value)) {
        for (const pipe of ref.pipes) {
          const spec = PIPES[pipe.name];
          if (!spec) {
            issues.push({
              code: "B4",
              severity: "error",
              nodeId: node.id,
              path: t.prop,
              message: `${ref.text}: unknown pipe "${pipe.name}" — the pipes are ${Object.keys(PIPES).join(", ")}`,
            });
          } else if (!spec.arity.includes(pipe.args.length)) {
            issues.push({
              code: "B4",
              severity: "error",
              nodeId: node.id,
              path: t.prop,
              message: `${ref.text}: "${pipe.name}" takes ${spec.arity.join(" or ")} argument(s), got ${pipe.args.length} — ${spec.doc}`,
            });
          }
        }
      }
    }
  }
  return issues;
}

/**
 * Check every binding in the tree against a data sample.
 *
 * Scopes follow the Repeaters: inside `Repeater{over: "news.items", as: "article"}`
 * the name `article` is one merged item of `news.items`.
 */
export function checkBindings(tree: FlatTree, data: unknown): Issue[] {
  const issues: Issue[] = [];
  const add = (issue: Issue) => issues.push(issue);
  const root = inferShape(data);
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const scopes = new Map<string, Shape>();

  /** The scope a node's OWN props see — its parent's, plus the alias if the parent repeats. */
  const scopeOf = (node: FlatNode): Shape => {
    const hit = scopes.get(node.id);
    if (hit) return hit;
    const parent = node.parent === null ? undefined : byId.get(node.parent);
    let scope = parent ? scopeOf(parent) : root;
    if (parent?.type === "Repeater") {
      const over = String(parent.props.over ?? "");
      const as = String(parent.props.as ?? "");
      const list = walkShape(scope, over);
      if (as && list.ok && list.shape.kind === "array" && list.shape.of && scope.kind === "object") {
        scope = { ...scope, fields: new Map(scope.fields).set(as, list.shape.of) };
      }
    }
    scopes.set(node.id, scope);
    return scope;
  };

  const missing = (node: FlatNode, prop: string, label: string, path: string, w: Walk & { ok: false }) => {
    const head = path.split(".")[0]!;
    const where = w.at === head ? `no "${head}" in scope` : `"${w.at.split(".").slice(0, -1).join(".")}" has no "${w.at.split(".").pop()}"`;
    add({
      code: "B1",
      severity: "error",
      nodeId: node.id,
      path: prop,
      message: `${label}: ${where}${offered(w.parent)}`,
    });
  };

  const pageKey = (node: FlatNode, prop: string, label: string, key: string) =>
    add({
      code: "B3",
      severity: "warning",
      nodeId: node.id,
      path: prop,
      message: `${label} walks through "${key}" — a CAST flow keys its items by PAGE number, so this draws page ${key.split(".").pop()} and nothing else. Normalise the response (fromCastFlow) and bind "items".`,
    });

  for (const node of tree.nodes) {
    const scope = scopeOf(node);

    // --- refs in templates ----------------------------------------------
    for (const t of templatesIn(node.props)) {
      for (const ref of parseRefs(t.value)) {
        const w = walkShape(scope, ref.path);
        if (w.pageKey) pageKey(node, t.prop, ref.text, w.pageKey);
        if (!w.ok) {
          if (!ref.pipes.some((p) => p.name === "default")) missing(node, t.prop, ref.text, ref.path, w);
          continue;
        }
        checkRef(node, t.prop, ref, w.shape, add);
      }
    }

    // --- Repeater.over --------------------------------------------------
    if (node.type === "Repeater" && typeof node.props.over === "string") {
      const over = node.props.over;
      const w = walkShape(scope, over);
      if (w.pageKey) pageKey(node, "over", `over "${over}"`, w.pageKey);
      if (!w.ok) missing(node, "over", `over "${over}"`, over, w);
      else if (w.shape.kind !== "array") {
        add({
          code: "B2",
          severity: "error",
          nodeId: node.id,
          path: "over",
          message: `over "${over}" is ${describe(w.shape)}, not a list${w.shape.kind === "object" && w.shape.fields.has("items") ? ` — did you mean "${over}.items"?` : ""}`,
        });
      }
    }

    // --- when -----------------------------------------------------------
    const parsed = node.props.when === undefined ? undefined : predicateSchema.safeParse(node.props.when);
    if (parsed?.success) {
      for (const c of conditionsOf(parsed.data)) {
        const w = walkShape(scope, c.path);
        if (!w.ok) {
          missing(node, "when", `when "${c.path}"`, c.path, w);
          continue;
        }
        const compared = c.eq !== undefined ? [c.eq] : c.ne !== undefined ? [c.ne] : (c.in ?? []);
        const holds = w.shape.kind === "scalar" ? w.shape.types : null;
        const strays = holds
          ? compared.filter((v) => !holds.has(v === null ? "null" : (typeof v as ScalarType)))
          : [];
        if (strays.length > 0) {
          add({
            code: "B7",
            severity: "warning",
            nodeId: node.id,
            path: "when",
            message: `when "${c.path}" compares against ${strays.map((s) => JSON.stringify(s)).join(", ")}, but the field only holds ${[...holds!].join(" | ")} — strict equality will never match`,
          });
        }
      }
    }
  }
  return issues;

  function checkRef(node: FlatNode, prop: string, ref: Ref, shape: Shape, add: (i: Issue) => void): void {
    if (shape.kind !== "scalar") {
      add({
        code: "B2",
        severity: "error",
        nodeId: node.id,
        path: prop,
        message: `${ref.text} is ${describe(shape)} — a template draws text; bind one of its fields${offered(shape)}`,
      });
      return;
    }
    const dated = ref.pipes.some((p) => p.name === "date");
    if (dated && !shape.isoDate && !shape.types.has("number")) {
      add({
        code: "B4",
        severity: "warning",
        nodeId: node.id,
        path: prop,
        message: `${ref.text}: "date" on a field whose sample values are not dates`,
      });
    }
    if (!dated && shape.isoDate) {
      add({
        code: "B5",
        severity: "warning",
        nodeId: node.id,
        path: prop,
        message: `${ref.text} is an ISO timestamp drawn raw — add a pipe, e.g. {${ref.path} | date:"MMM DD, YYYY"}`,
      });
    }
    if (node.type === "Image" && prop === "src" && shape.ratioSlot) {
      const ratio = typeof node.props.ratio === "string" ? node.props.ratio.replace(/\s/g, "") : undefined;
      if (!ratio) {
        add({
          code: "B6",
          severity: "warning",
          nodeId: node.id,
          path: "ratio",
          message: `${ref.text} has the CDN ${RATIO_SLOT} slot and this Image has no ratio, so the CDN serves its 16:9 default whatever the box is — set ratio to the box's aspect (${CDN_RATIOS.join(", ")})`,
        });
      } else if (!(CDN_RATIOS as readonly string[]).includes(ratio)) {
        add({
          code: "B6",
          severity: "error",
          nodeId: node.id,
          path: "ratio",
          message: `ratio "${ratio}" is not a crop the media CDN serves — it answers 200 with a 1×1 pixel. Use one of ${CDN_RATIOS.join(", ")}`,
        });
      }
    }
  }
}

function describe(shape: Shape): string {
  if (shape.kind === "array") return "a list";
  if (shape.kind === "object") return "an object";
  return [...shape.types].join(" | ");
}
