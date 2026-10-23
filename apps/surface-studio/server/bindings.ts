/**
 * Where the tree meets data.
 *
 * Three questions, answered from the compiled tree and a sample payload:
 *
 *   1. What does the tree already ask for?     refs, repeaters, whether they resolve
 *   2. What COULD it ask for?                  sibling runs that look like one component,
 *                                              literal copy that equals a value in the sample
 *   3. What does the payload offer that the    scalar paths nothing reads — the fields an API
 *      tree never reads?                       added after the design was drawn
 *
 * Suggestions are proposals. Nothing here edits a tree on its own: whether six
 * identical cards are one data-driven list or six deliberate placements is a
 * statement about the CMS, and only the person who knows it can make it. What
 * this removes is the typing — the paths, the `src` ids, the member lists — so
 * accepting a suggestion is a click and rejecting one is free.
 *
 * Keyed by `src` throughout, for the reason `bind.ts` gives: a DSL node id is
 * derived from a layer NAME and moves when the designer renames it.
 */
import {
  applyBindingPlan,
  proposeCollapse,
  type BindingPlan,
  type CollapseProposal,
  type FlatNode,
  type FlatTree,
} from "@fanos/dsl";

import type {
  BindingsResult,
  BoundRef,
  PlanBindingWire,
  PlanCollapseWire,
  PlanWire,
  ProposalRow,
  RepeaterRow,
  ShapePath,
  Suggestion,
} from "../src/inspect-types.js";
import { runPipeline, surfacesForRender, wireTree } from "./pipeline.js";
import { renderPreview } from "./preview.js";

const REF_RE = /\{([A-Za-z_][A-Za-z0-9_.]*)\}/g;

/** Props that carry a value a CMS could own. */
const BINDABLE_PROPS = ["content", "label", "alt", "src", "href", "to"] as const;

const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/* ------------------------------------------------------------------------- */
/* Reading refs out of a tree                                                 */
/* ------------------------------------------------------------------------- */

interface RawRef {
  nodeId: string;
  prop: string;
  path: string;
}

/** Every `{path}` in every string prop, nested objects included. `_meta` is prose. */
export function collectRefs(tree: FlatTree): RawRef[] {
  const out: RawRef[] = [];
  const visit = (nodeId: string, value: unknown, prop: string): void => {
    if (typeof value === "string") {
      for (const m of value.matchAll(REF_RE)) out.push({ nodeId, prop, path: m[1] as string });
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => visit(nodeId, v, `${prop}[${i}]`));
    } else if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) visit(nodeId, v, prop ? `${prop}.${k}` : k);
    }
  };
  for (const node of tree.nodes) {
    for (const [k, v] of Object.entries(node.props)) {
      if (k === "_meta") continue;
      visit(node.id, v, k);
    }
  }
  return out;
}

export const countRefs = (tree: FlatTree): number => collectRefs(tree).length;
export const countRepeaters = (tree: FlatTree): number =>
  tree.nodes.filter((n) => n.type === "Repeater").length;

/** Doc-level dot-path read. Arrays are not indexed — the renderer's rule. */
function lookup(data: unknown, path: string): unknown {
  let cur: unknown = data;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Repeater ancestors of a node, nearest first, with the alias each introduces. */
function scopesOf(tree: FlatTree, node: FlatNode, byId: Map<string, FlatNode>): Array<{ as: string; over: string }> {
  const scopes: Array<{ as: string; over: string }> = [];
  // A Repeater is a FRAGMENT: it scopes its CHILDREN, so the walk is over the
  // node's ancestors, and a Repeater node's own props are read at its parent's scope.
  let cur = node.parent ? byId.get(node.parent) : undefined;
  while (cur) {
    if (cur.type === "Repeater") {
      const as = cur.props.as;
      const over = cur.props.over;
      if (typeof as === "string" && typeof over === "string") scopes.push({ as, over });
    }
    cur = cur.parent ? byId.get(cur.parent) : undefined;
  }
  return scopes;
}

/* ------------------------------------------------------------------------- */
/* Shape of a payload                                                         */
/* ------------------------------------------------------------------------- */

const MAX_SHAPE = 400;
const MAX_DEPTH = 7;

function inferShape(data: unknown): ShapePath[] {
  const out: ShapePath[] = [];
  const push = (row: Omit<ShapePath, "used">): void => {
    if (out.length < MAX_SHAPE) out.push({ ...row, used: false });
  };

  const walk = (value: unknown, path: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    if (Array.isArray(value)) {
      push({ path, type: "array", length: value.length });
      // The item shape is the UNION of every item's keys, so a field only the
      // third article has still shows up — that is the one a new API release adds.
      const merged = new Map<string, unknown>();
      for (const item of value) {
        if (item !== null && typeof item === "object" && !Array.isArray(item)) {
          for (const [k, v] of Object.entries(item)) if (!merged.has(k) || merged.get(k) == null) merged.set(k, v);
        }
      }
      for (const [k, v] of merged) walk(v, `${path}[].${k}`, depth + 1);
      return;
    }
    if (value !== null && typeof value === "object") {
      if (path !== "") push({ path, type: "object" });
      for (const [k, v] of Object.entries(value)) walk(v, path === "" ? k : `${path}.${k}`, depth + 1);
      return;
    }
    const type = value === null ? "null" : (typeof value as "string" | "number" | "boolean");
    push({ path, type, sample: truncate(String(value), 60) });
  };

  walk(data, "", 0);
  return out;
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** The element a field would most naturally become. A hint, never a decision. */
function hintFor(row: ShapePath): ShapePath["hint"] {
  if (row.type === "boolean") return "when";
  if (row.type !== "string" || !row.sample) return row.type === "number" ? "Text" : undefined;
  if (/\.(jpe?g|png|webp|gif|svg|avif)(\?|$)/i.test(row.sample)) return "Image";
  if (/^https?:\/\//i.test(row.sample)) return "Link";
  if (/^\d{4}-\d{2}-\d{2}([T ]|$)/.test(row.sample)) return "date";
  return "Text";
}

/* ------------------------------------------------------------------------- */
/* Suggestions                                                                */
/* ------------------------------------------------------------------------- */

function childrenIndex(tree: FlatTree): Map<string, FlatNode[]> {
  const kids = new Map<string, FlatNode[]>();
  for (const n of tree.nodes) {
    if (n.parent === null) continue;
    const list = kids.get(n.parent) ?? [];
    list.push(n);
    kids.set(n.parent, list);
  }
  for (const list of kids.values()) list.sort((a, b) => a.idx - b.idx);
  return kids;
}

/** Template node -> the node at the same position in another member. */
function pairUp(kids: Map<string, FlatNode[]>, byId: Map<string, FlatNode>, template: string, member: string): Map<string, FlatNode> {
  const pairs = new Map<string, FlatNode>();
  const visit = (a: string, b: string): void => {
    const nb = byId.get(b);
    if (nb) pairs.set(a, nb);
    const ka = kids.get(a) ?? [];
    const kb = kids.get(b) ?? [];
    // Members share a subtree signature, so shapes agree; `min` is belt and braces.
    for (let i = 0; i < Math.min(ka.length, kb.length); i++) visit(ka[i]!.id, kb[i]!.id);
  };
  visit(template, member);
  return pairs;
}

function singular(path: string): string {
  const leaf = (path.split(".").pop() ?? "item").replace(/\[\]$/, "");
  const word = leaf.endsWith("ies") ? `${leaf.slice(0, -3)}y` : leaf.endsWith("s") && leaf.length > 2 ? leaf.slice(0, -1) : leaf;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(word) && word !== leaf ? word : "item";
}

/** Every array of objects in the sample, by dotted path. */
function listsIn(data: unknown): Array<{ path: string; items: Array<Record<string, unknown>> }> {
  const lists: Array<{ path: string; items: Array<Record<string, unknown>> }> = [];
  const walk = (value: unknown, path: string, depth: number): void => {
    if (depth > MAX_DEPTH || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      const items = value.filter((v): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v));
      // Only a path the renderer can address: it indexes object keys, not arrays.
      if (items.length > 0 && path !== "" && !path.includes("[]")) lists.push({ path, items });
      return;
    }
    for (const [k, v] of Object.entries(value)) walk(v, path === "" ? k : `${path}.${k}`, depth + 1);
  };
  walk(data, "", 0);
  return lists;
}

function suggest(tree: FlatTree, proposals: CollapseProposal[], data: Record<string, unknown> | undefined): Suggestion[] {
  if (!data) return [];

  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const kids = childrenIndex(tree);
  const lists = listsIn(data);
  const out: Suggestion[] = [];

  /** Nodes under a suggested collapse — their literal copy is spoken for. */
  const claimed = new Set<string>();
  const markSubtree = (id: string): void => {
    claimed.add(id);
    for (const k of kids.get(id) ?? []) markSubtree(k.id);
  };

  for (const proposal of proposals) {
    if (proposal.count < 2) continue;

    let best: { list: (typeof lists)[number]; start: number; fields: PlanBindingWire[] } | null = null;

    for (const list of lists) {
      if (list.items.length < proposal.count) continue;

      // Per-member values for every string prop that differs across members.
      const columns: Array<{ templateId: string; src: string; prop: string; values: string[] }> = [];
      const pairings = proposal.memberIds.map((m) => pairUp(kids, byId, proposal.templateId, m));
      const templateNodes = [proposal.templateId, ...descendantsOf(kids, proposal.templateId)];
      for (const tid of templateNodes) {
        const t = byId.get(tid);
        if (!t || t.src.startsWith("synthetic:")) continue;
        for (const prop of BINDABLE_PROPS) {
          if (typeof t.props[prop] !== "string") continue;
          const values = pairings.map((p) => {
            const v = p.get(tid)?.props[prop];
            return typeof v === "string" ? v : "";
          });
          if (new Set(values.map(norm)).size > 1) columns.push({ templateId: tid, src: t.src, prop, values });
        }
      }

      // Slide a window down the list: an index-tiered grid draws the same array
      // in several tiers, so the run need not start at the top.
      for (let start = 0; start + proposal.count <= list.items.length; start++) {
        const fields: PlanBindingWire[] = [];
        const used = new Set<string>();
        for (const col of columns) {
          const keys = new Set<string>();
          for (const item of list.items.slice(start, start + proposal.count)) for (const k of Object.keys(item)) keys.add(k);
          for (const key of keys) {
            if (used.has(key)) continue;
            const aligned = col.values.every((v, i) => {
              const cell = list.items[start + i]?.[key];
              return (typeof cell === "string" || typeof cell === "number") && norm(String(cell)) === norm(v);
            });
            if (aligned) {
              fields.push({ src: col.src, prop: col.prop, path: key });
              used.add(key);
              break;
            }
          }
        }
        const better =
          !best ||
          fields.length > best.fields.length ||
          (fields.length === best.fields.length && fields.length > 0 && list.items.length === proposal.count && best.list.items.length !== proposal.count);
        if (fields.length > 0 && better) best = { list, start, fields };
      }
    }

    const members = proposal.memberIds.map((id) => byId.get(id)?.src).filter((s): s is string => Boolean(s));
    if (members.length !== proposal.memberIds.length) continue;

    if (best) {
      const windowed = best.start !== 0 || proposal.count < best.list.items.length;
      const entry: PlanCollapseWire = {
        over: best.list.path,
        as: singular(best.list.path),
        ...(windowed ? { slice: [best.start, best.start + proposal.count] as [number, number] } : {}),
        members,
        fields: best.fields,
      };
      out.push({
        kind: "collapse",
        basis: "aligned",
        summary: `${proposal.count} cards → ${entry.over}${windowed ? `[${best.start}..${best.start + proposal.count}]` : ""} · ${best.fields.length} field${best.fields.length === 1 ? "" : "s"} matched by value`,
        entry,
      });
      markSubtree(proposal.templateId);
      for (const m of proposal.memberIds) markSubtree(m);
      continue;
    }

    // Nothing aligned. If exactly one list is long enough, the repeat is still
    // worth proposing — and the API's own key order usually mirrors the card's
    // layout (headline, summary, date, thumbnail), so map by POSITION and say so.
    // A guess, labelled as one: the render beside it is how it gets checked.
    const fits = lists.filter((l) => l.items.length >= proposal.count);
    if (fits.length === 1) {
      const list = fits[0]!;
      const fields = positional(tree, kids, byId, proposal.templateId, list.items[0] ?? {});
      out.push({
        kind: "collapse",
        basis: "ambiguous",
        summary:
          `${proposal.count} cards → ${list.path} (${list.items.length} items) · ` +
          (fields.length > 0
            ? `the design's copy matches no field, so ${fields.length} are mapped by position — check the render`
            : "the design's copy matches no field, bind each by hand"),
        entry: { over: list.path, as: singular(list.path), members, ...(fields.length > 0 ? { fields } : {}) },
      });
      for (const m of proposal.memberIds) markSubtree(m);
    }
  }

  // Literal copy that IS a value in the sample.
  const scalars: Array<{ path: string; value: string }> = [];
  const collect = (value: unknown, path: string, depth: number): void => {
    if (depth > MAX_DEPTH || Array.isArray(value)) return;
    if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) collect(v, path === "" ? k : `${path}.${k}`, depth + 1);
    } else if ((typeof value === "string" || typeof value === "number") && path !== "") {
      scalars.push({ path, value: String(value) });
    }
  };
  collect(data, "", 0);

  for (const node of tree.nodes) {
    if (claimed.has(node.id) || node.src.startsWith("synthetic:")) continue;
    for (const prop of BINDABLE_PROPS) {
      const v = node.props[prop];
      if (typeof v !== "string" || v.trim() === "" || /\{/.test(v)) continue;
      const hits = scalars.filter((s) => norm(s.value) === norm(v));
      if (hits.length === 0) continue;
      const exact = hits.length === 1;
      out.push({
        kind: "bind",
        basis: exact ? "exact" : "ambiguous",
        summary: `"${truncate(v, 36)}" → ${hits[0]!.path}${exact ? "" : `  (also ${hits.slice(1, 3).map((h) => h.path).join(", ")})`}`,
        entry: { src: node.src, prop, path: hits[0]!.path },
      });
    }
  }

  return out;
}

/**
 * Template Text / Image nodes, in document order, against an item's fields in
 * key order. Images take image-URL fields; Text takes the other scalars.
 * Stops at whichever side runs out — an extra node or field is left unbound
 * rather than guessed at.
 */
function positional(
  _tree: FlatTree,
  kids: Map<string, FlatNode[]>,
  byId: Map<string, FlatNode>,
  templateId: string,
  item: Record<string, unknown>,
): PlanBindingWire[] {
  const nodes = [templateId, ...descendantsOf(kids, templateId)]
    .map((id) => byId.get(id))
    .filter((n): n is FlatNode => n !== undefined && !n.src.startsWith("synthetic:"));
  const texts = nodes.filter((n) => n.type === "Text" && typeof n.props.content === "string");
  const images = nodes.filter((n) => n.type === "Image");

  const isImage = (v: unknown): boolean => typeof v === "string" && /\.(jpe?g|png|webp|gif|svg|avif)(\?|$)/i.test(v);
  const keys = Object.keys(item);
  const imageKeys = keys.filter((k) => isImage(item[k]));
  const textKeys = keys.filter(
    (k) => (typeof item[k] === "string" || typeof item[k] === "number") && !isImage(item[k]) && !/^https?:\/\//i.test(String(item[k])),
  );

  const out: PlanBindingWire[] = [];
  for (let i = 0; i < Math.min(texts.length, textKeys.length); i++) {
    out.push({ src: texts[i]!.src, prop: "content", path: textKeys[i]! });
  }
  for (let i = 0; i < Math.min(images.length, imageKeys.length); i++) {
    out.push({ src: images[i]!.src, prop: "src", path: imageKeys[i]! });
  }
  return out;
}

function descendantsOf(kids: Map<string, FlatNode[]>, id: string): string[] {
  const out: string[] = [];
  for (const k of kids.get(id) ?? []) {
    out.push(k.id, ...descendantsOf(kids, k.id));
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* The endpoint's body                                                        */
/* ------------------------------------------------------------------------- */

export interface BindingsInput {
  ir: unknown;
  theme: unknown;
  width?: number | undefined;
  render?: boolean | undefined;
  icons?: Readonly<Record<string, string>> | undefined;
  data?: Record<string, unknown>;
  plan?: PlanWire;
}

export async function analyzeBindings(input: BindingsInput): Promise<BindingsResult> {
  const { doc, compiled } = runPipeline(input);
  const compiledTree = compiled.tree;

  // Proposals and suggestions come from the tree AS COMPILED: a plan is keyed by
  // `src`, and once a run is collapsed its members are gone from the tree.
  const proposals = proposeCollapse(compiledTree);
  const suggestions = suggest(compiledTree, proposals, input.data);

  const applied = input.plan ? applyBindingPlan(compiledTree, input.plan as BindingPlan) : undefined;
  const tree = applied?.tree ?? compiledTree;

  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const shape = input.data ? inferShape(input.data) : [];

  // Which sample paths does the tree read?
  const usedPaths = new Set<string>();
  const unresolved = new Set<string>();

  const refs: BoundRef[] = collectRefs(tree).map((ref) => {
    const node = byId.get(ref.nodeId)!;
    const scope = scopesOf(tree, node, byId).find((s) => ref.path === s.as || ref.path.startsWith(`${s.as}.`));

    const display = scope ? `${scope.over}[]${ref.path.slice(scope.as.length)}` : ref.path;
    usedPaths.add(display);

    if (!input.data) return { nodeId: ref.nodeId, prop: ref.prop, path: display, resolved: null };

    let found: unknown;
    if (scope) {
      const list = lookup(input.data, scope.over);
      const first = Array.isArray(list) ? list[0] : undefined;
      found = ref.path === scope.as ? first : lookup(first, ref.path.slice(scope.as.length + 1));
    } else {
      found = lookup(input.data, ref.path);
    }

    if (found === undefined) unresolved.add(display);
    return {
      nodeId: ref.nodeId,
      prop: ref.prop,
      path: display,
      resolved: found !== undefined,
      ...(found !== undefined && typeof found !== "object" ? { sample: truncate(String(found), 48) } : {}),
    };
  });

  const repeaters: RepeaterRow[] = tree.nodes
    .filter((n) => n.type === "Repeater")
    .map((n) => {
      const over = String(n.props.over ?? "");
      usedPaths.add(over);
      const list = input.data ? lookup(input.data, over) : undefined;
      return {
        nodeId: n.id,
        over,
        as: String(n.props.as ?? ""),
        ...(Array.isArray(n.props.slice) ? { slice: n.props.slice as [number, number] } : {}),
        ...(typeof n.props.limit === "number" ? { limit: n.props.limit } : {}),
        items: input.data ? (Array.isArray(list) ? list.length : 0) : null,
      };
    });

  for (const row of shape) {
    row.used = usedPaths.has(row.path) || [...usedPaths].some((p) => p.startsWith(`${row.path}.`) || p.startsWith(`${row.path}[]`));
    const h = hintFor(row);
    if (h && !row.used && row.type !== "object" && row.type !== "array") row.hint = h;
  }

  const unused = shape.filter((s) => !s.used && s.type !== "object" && s.type !== "array").map((s) => s.path);

  const result: BindingsResult = {
    refs,
    repeaters,
    proposals: proposals.map(
      (p): ProposalRow => ({
        parentId: p.parentId,
        templateId: p.templateId,
        memberIds: p.memberIds,
        count: p.count,
        nodesSaved: p.nodesSaved,
        varying: Object.entries(p.varyingContent).flatMap(([nodeId, list]) =>
          list.map((v) => ({ nodeId, prop: v.prop, values: v.values.map((x) => truncate(x, 40)) })),
        ),
      }),
    ),
    shape,
    suggestions,
    unresolved: [...unresolved],
    unused,
    ...(applied
      ? {
          applied: {
            bound: applied.bound,
            collapsed: applied.collapsed,
            drift: applied.drift.map((d) => ({ reason: d.reason, src: d.src, message: d.message })),
          },
        }
      : {}),
    dsl: wireTree(tree),
  };

  if (input.render) {
    const width = input.width ?? (Math.round(doc.root.geometry.relBbox.w) || undefined);
    const rendered = await renderPreview({
      tree,
      theme: input.theme,
      surfaces: surfacesForRender(compiled),
      ...(width ? { width } : {}),
      ...(input.data ? { data: input.data } : {}),
    });
    result.html = rendered.html;
    result.width = rendered.width;
  }

  return result;
}
