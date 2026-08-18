/**
 * Part 8 — Tree operations, for the repair loop.
 *
 * Repair PATCHES the tree; it never regenerates it. Regeneration is how drift
 * creeps in across iterations — the model fixes the reported problem and
 * silently rewrites three things nobody asked about.
 *
 * Every function is pure and returns a NEW tree. Nodes that are not touched are
 * carried over by reference, so a patch is cheap even on a large page.
 *
 * PURE. No filesystem, no process, no clock.
 */

import { syntheticSrc, type FlatNode, type FlatTree } from "./flat.js";

export class TreeOpError extends Error {
  readonly nodeId: string | undefined;

  constructor(message: string, nodeId?: string) {
    super(message);
    this.name = "TreeOpError";
    this.nodeId = nodeId;
  }
}

function requireNode(tree: FlatTree, id: string): FlatNode {
  const node = tree.nodes.find((n) => n.id === id);
  if (!node) throw new TreeOpError(`no node with id "${id}"`, id);
  return node;
}

function withNodes(tree: FlatTree, nodes: FlatNode[]): FlatTree {
  return { schemaVersion: tree.schemaVersion, nodes };
}

/** Deep-clones only the objects along `path`, leaving untouched branches shared. */
function setIn(target: Record<string, unknown>, path: readonly string[], value: unknown): Record<string, unknown> {
  const [head, ...rest] = path;
  if (head === undefined) throw new TreeOpError("setProp: empty path");
  if (rest.length === 0) return { ...target, [head]: value };
  const child = target[head];
  const nextTarget = typeof child === "object" && child !== null && !Array.isArray(child)
    ? (child as Record<string, unknown>)
    : {};
  return { ...target, [head]: setIn(nextTarget, rest, value) };
}

/** `setProp(tree, "name", "space.pt", "space.4")` — dotted path into `props`. */
export function setProp(tree: FlatTree, id: string, path: string, value: unknown): FlatTree {
  requireNode(tree, id);
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0) throw new TreeOpError("setProp: empty path", id);
  return withNodes(
    tree,
    tree.nodes.map((n) => (n.id === id ? { ...n, props: setIn(n.props, segments, value) } : n)),
  );
}

/**
 * Swap a node's type and props, keeping its identity and position.
 *
 * `id`, `parent` and `idx` are NOT taken from the replacement — the whole point
 * is that the node stays where it is and its children stay attached.
 */
export function replaceNode(
  tree: FlatTree,
  id: string,
  next: { type: string; src?: string; props: Record<string, unknown> },
): FlatTree {
  const existing = requireNode(tree, id);
  return withNodes(
    tree,
    tree.nodes.map((n) =>
      n.id === id ? { ...existing, type: next.type, src: next.src ?? existing.src, props: next.props } : n,
    ),
  );
}

/**
 * Insert a new parent between `id` and its current parent.
 *
 * The wrapper takes the wrapped node's slot, and the wrapped node becomes its
 * only child. The wrapper is synthetic by construction — the design did not draw
 * it — so it gets a `synthetic:` src that still points at where it came from.
 */
export function wrapIn(
  tree: FlatTree,
  id: string,
  wrapperType: string,
  props: Record<string, unknown> = {},
  wrapperId = `${id}__wrap`,
): FlatTree {
  const node = requireNode(tree, id);
  if (tree.nodes.some((n) => n.id === wrapperId)) {
    throw new TreeOpError(`wrapper id "${wrapperId}" is already taken`, wrapperId);
  }

  const wrapper: FlatNode = {
    id: wrapperId,
    parent: node.parent,
    idx: node.idx,
    type: wrapperType,
    src: syntheticSrc(node.src, 0),
    props,
  };

  const nodes = tree.nodes.map((n) => (n.id === id ? { ...n, parent: wrapperId, idx: 0 } : n));
  // Placed immediately before the node it wraps, so a flat file still reads
  // top-down and `flatten(reify(x))` keeps document order.
  const at = nodes.findIndex((n) => n.id === id);
  nodes.splice(at, 0, wrapper);
  return withNodes(tree, nodes);
}

/** Insert `node` at `siblingId`'s index, shifting it and everything after it down. */
export function insertBefore(
  tree: FlatTree,
  siblingId: string,
  node: Omit<FlatNode, "parent" | "idx">,
): FlatTree {
  const sibling = requireNode(tree, siblingId);
  if (tree.nodes.some((n) => n.id === node.id)) {
    throw new TreeOpError(`node id "${node.id}" is already taken`, node.id);
  }

  const nodes = tree.nodes.map((n) =>
    n.parent === sibling.parent && n.idx >= sibling.idx ? { ...n, idx: n.idx + 1 } : n,
  );
  const at = nodes.findIndex((n) => n.id === siblingId);
  nodes.splice(at, 0, { ...node, parent: sibling.parent, idx: sibling.idx });
  return withNodes(tree, nodes);
}

export interface RemoveOptions {
  /** Remove the whole subtree. Without it, removing a node with children errors. */
  cascade?: boolean;
}

export function removeNode(tree: FlatTree, id: string, options: RemoveOptions = {}): FlatTree {
  const node = requireNode(tree, id);
  if (node.parent === null) throw new TreeOpError(`cannot remove the root node "${id}"`, id);

  const children = tree.nodes.filter((n) => n.parent === id);
  if (children.length > 0 && !options.cascade) {
    throw new TreeOpError(
      `"${id}" has ${children.length} children; pass { cascade: true } to remove the subtree`,
      id,
    );
  }

  const doomed = new Set<string>([id]);
  if (options.cascade) {
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of tree.nodes) {
        if (n.parent !== null && doomed.has(n.parent) && !doomed.has(n.id)) {
          doomed.add(n.id);
          grew = true;
        }
      }
    }
  }

  // Close the gap the removal leaves, so idx stays contiguous and reify passes.
  const kept = tree.nodes
    .filter((n) => !doomed.has(n.id))
    .map((n) => (n.parent === node.parent && n.idx > node.idx ? { ...n, idx: n.idx - 1 } : n));

  return withNodes(tree, kept);
}

/**
 * Move a node to a new parent and index.
 *
 * Refuses to move a node into its own subtree — that produces a detached cycle
 * that only surfaces later as a confusing S1.
 */
export function moveNode(tree: FlatTree, id: string, newParent: string, idx: number): FlatTree {
  const node = requireNode(tree, id);
  requireNode(tree, newParent);
  if (node.parent === null) throw new TreeOpError(`cannot move the root node "${id}"`, id);

  const subtree = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of tree.nodes) {
      if (n.parent !== null && subtree.has(n.parent) && !subtree.has(n.id)) {
        subtree.add(n.id);
        grew = true;
      }
    }
  }
  if (subtree.has(newParent)) {
    throw new TreeOpError(`cannot move "${id}" into its own subtree ("${newParent}")`, id);
  }

  const siblingCount = tree.nodes.filter((n) => n.parent === newParent && n.id !== id).length;
  const target = Math.max(0, Math.min(idx, siblingCount));

  return withNodes(
    tree,
    tree.nodes.map((n) => {
      if (n.id === id) return { ...n, parent: newParent, idx: target };
      // Close the gap at the old location…
      let next = n;
      if (n.parent === node.parent && n.idx > node.idx) next = { ...next, idx: next.idx - 1 };
      // …then open one at the new.
      const idxAfterClose = next.idx;
      if (n.parent === newParent && idxAfterClose >= target) next = { ...next, idx: idxAfterClose + 1 };
      return next;
    }),
  );
}

export interface CollapseOptions {
  /**
   * The sibling instances the design drew, in document order. The FIRST is kept
   * as the template; the rest are removed with their subtrees.
   */
  instances: readonly string[];
  /** Dotted path to the array the template repeats over, e.g. `section.briefs`. */
  over: string;
  /** The alias one item binds under inside the template, e.g. `brief`. */
  as: string;
  /**
   * How many items to render.
   *
   * Defaults to the number of instances the design drew, which is a fact about
   * the design rather than a guess: a column laid out for three cards is not a
   * column for ten, and an API that returns ten would otherwise push the page
   * apart. Pass `null` for a genuinely unbounded list.
   */
  limit?: number | null;
  /** Id for the inserted Repeater. Defaults to `<template>__repeat`. */
  id?: string;
}

/** `{section.briefs.2.headline}` -> `{brief.headline}`, for one array and alias. */
function realias(value: string, over: string, as: string): string {
  const escaped = over.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\{${escaped}\\.\\d+((?:\\.[A-Za-z_][A-Za-z0-9_]*)*)\\}`, "g");
  return value.replace(re, (_match, rest: string) => `{${as}${rest}}`);
}

/** Rewrite every string in a props bag, at any depth. */
function rebindProps(value: unknown, over: string, as: string): unknown {
  if (typeof value === "string") return realias(value, over, as);
  if (Array.isArray(value)) return value.map((v) => rebindProps(v, over, as));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, rebindProps(v, over, as)]),
    );
  }
  return value;
}

/** Every id in `id`'s subtree, including itself. */
function subtreeOf(tree: FlatTree, id: string): Set<string> {
  const ids = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of tree.nodes) {
      if (n.parent !== null && ids.has(n.parent) && !ids.has(n.id)) {
        ids.add(n.id);
        grew = true;
      }
    }
  }
  return ids;
}

/**
 * N sibling instances of one component -> one template under a Repeater.
 *
 * The mechanical half of "these three cards are one card, three times". It does
 * the surgery and nothing else: which siblings are instances, which array they
 * come from and what an item is called are all decided by the caller, because
 * they cannot be derived. `canonicalSignature` gets close — on a real news
 * section it grouped the three briefs correctly, missed two feature cards that
 * differ by an 8px gap, and confidently grouped six headline/summary text pairs
 * that have nothing to do with each other. It is a way to find CANDIDATES, not
 * an answer, so the answer is an argument here.
 *
 * Bindings are re-aliased on the way: the design's instances were bound by
 * index, and one template cannot be, so `{section.briefs.2.headline}` becomes
 * `{brief.headline}` throughout the kept subtree. Any index is rewritten, not
 * just zero — the caller may keep whichever instance is the cleanest.
 *
 * Coverage survives this. C1 in @fanos/conform counts everything under a
 * container holding a Repeater as `repeated` rather than `missing`, so the two
 * removed cards are still accounted for against the IR.
 */
export function collapseToRepeater(tree: FlatTree, options: CollapseOptions): FlatTree {
  const { instances, over, as } = options;

  if (instances.length === 0) throw new TreeOpError("collapseToRepeater: no instances given");
  if (new Set(instances).size !== instances.length) {
    throw new TreeOpError("collapseToRepeater: an instance is listed twice");
  }
  if (!over.trim()) throw new TreeOpError("collapseToRepeater: `over` is empty");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(as)) {
    throw new TreeOpError(
      `collapseToRepeater: \`as\` must be a bare name — "${as}" cannot be the head of a data path`,
    );
  }

  const nodes = instances.map((id) => requireNode(tree, id));
  const template = nodes[0]!;
  if (template.parent === null) {
    throw new TreeOpError(`cannot collapse the root node "${template.id}"`, template.id);
  }
  const strayParent = nodes.find((n) => n.parent !== template.parent);
  if (strayParent) {
    throw new TreeOpError(
      `collapseToRepeater: "${strayParent.id}" is not a sibling of "${template.id}" — ` +
        `instances of one component share a parent`,
      strayParent.id,
    );
  }

  // Re-alias first, while the template is still where the caller found it.
  const kept = subtreeOf(tree, template.id);
  let next: FlatTree = withNodes(
    tree,
    tree.nodes.map((n) =>
      kept.has(n.id)
        ? { ...n, props: rebindProps(n.props, over, as) as Record<string, unknown> }
        : n,
    ),
  );

  for (const extra of instances.slice(1)) {
    next = removeNode(next, extra, { cascade: true });
  }

  const limit = options.limit === undefined ? instances.length : options.limit;
  return wrapIn(
    next,
    template.id,
    "Repeater",
    { over, as, ...(limit === null ? {} : { limit }) },
    options.id ?? `${template.id}__repeat`,
  );
}

// ---------------------------------------------------------------------------
// Applying a collapse proposal
// ---------------------------------------------------------------------------

export interface Binding {
  /** Dotted path to the source list, e.g. `news.items`. */
  over: string;
  /** What one item is called inside the template, e.g. `article`. */
  as: string;
  /** `[start, end)` window on the source. See the Repeater schema and S13. */
  slice?: [number, number];
  /**
   * Which template node's prop takes which field of the item.
   *
   * Keyed by node id so it lines up with a proposal's `varyingContent`, which
   * is where a binder gets its candidates. The path is relative to the ITEM,
   * not the document: `headline`, not `news.items.0.headline`.
   */
  fieldMap: Record<string, { prop: string; path: string }>;
}

/**
 * Fold a proposal's members into one template under a Repeater.
 *
 * The proposal says WHICH siblings; the binding says WHAT they are. Both are
 * arguments because neither can be derived from the other: `proposeCollapse`
 * can prove three subtrees are the same shape and cannot know they are
 * articles, and a data contract can name a list of articles and cannot know
 * which three boxes on the page draw it.
 *
 * `src` survives on every node that survives, and the removed members' `src`
 * values land on the Repeater as `_meta.collapsedFrom`. That is not
 * bookkeeping: `src` is the anchor a pixel diff maps a region back to and the
 * key drift detection joins on, so a Figma node whose DSL node has been folded
 * away must still be findable — otherwise collapsing a card makes two thirds of
 * the design look deleted the next time the file changes.
 */
export function applyCollapse(
  tree: FlatTree,
  proposal: {
    parentId: string;
    memberIds: readonly string[];
    templateId: string;
  },
  binding: Binding,
): FlatTree {
  const { memberIds, templateId } = proposal;

  if (memberIds.length === 0) throw new TreeOpError("applyCollapse: no members given");
  if (new Set(memberIds).size !== memberIds.length) {
    throw new TreeOpError("applyCollapse: a member is listed twice");
  }
  if (!memberIds.includes(templateId)) {
    throw new TreeOpError(`applyCollapse: template "${templateId}" is not one of the members`, templateId);
  }
  if (!binding.over.trim()) throw new TreeOpError("applyCollapse: `over` is empty");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding.as)) {
    throw new TreeOpError(
      `applyCollapse: \`as\` must be a bare name — "${binding.as}" cannot be the head of a data path`,
    );
  }
  if (binding.slice) {
    const [start, end] = binding.slice;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
      throw new TreeOpError(
        `applyCollapse: slice must be [start, end) with 0 <= start < end, got [${start}, ${end})`,
      );
    }
  }

  const members = memberIds.map((id) => requireNode(tree, id));
  const template = requireNode(tree, templateId);
  const stray = members.find((n) => n.parent !== proposal.parentId);
  if (stray) {
    throw new TreeOpError(
      `applyCollapse: "${stray.id}" is not a child of "${proposal.parentId}" — instances of one component share a parent`,
      stray.id,
    );
  }

  const kept = subtreeIds(tree, templateId);
  for (const [nodeId, entry] of Object.entries(binding.fieldMap)) {
    if (!kept.has(nodeId)) {
      throw new TreeOpError(
        `applyCollapse: fieldMap names "${nodeId}", which is not in the template "${templateId}" — a binding can only reach nodes that survive`,
        nodeId,
      );
    }
    if (!entry.path.trim()) {
      throw new TreeOpError(`applyCollapse: fieldMap["${nodeId}"] has an empty path`, nodeId);
    }
  }

  /**
   * The removed members' Figma ids, in document order, deduped.
   *
   * Every node under a removed member, not just its root: C1 in @fanos/conform
   * accounts for a whole subtree against the design, and a list holding only
   * the card roots would leave every headline inside them looking missing.
   */
  const removed = new Set<string>();
  for (const id of memberIds) {
    if (id === templateId) continue;
    for (const nodeId of subtreeIds(tree, id)) removed.add(nodeId);
  }
  const collapsedFrom: string[] = [];
  const seen = new Set<string>();
  // Document order, not traversal order — this list ends up in a stored tree
  // and a diff of two runs should show what changed, not how it was walked.
  for (const node of tree.nodes) {
    if (!removed.has(node.id) || seen.has(node.src)) continue;
    seen.add(node.src);
    collapsedFrom.push(node.src);
  }

  // Bind first, while the template is still where the proposal found it.
  let next: FlatTree = withNodes(
    tree,
    tree.nodes.map((n) => {
      const entry = binding.fieldMap[n.id];
      if (!entry || !kept.has(n.id)) return n;
      return { ...n, props: { ...n.props, [entry.prop]: `{${binding.as}.${entry.path}}` } };
    }),
  );

  for (const id of memberIds) {
    if (id === templateId) continue;
    next = removeNode(next, id, { cascade: true });
  }

  const repeaterProps: Record<string, unknown> = { over: binding.over, as: binding.as };
  if (binding.slice) repeaterProps.slice = [...binding.slice];
  if (collapsedFrom.length > 0) repeaterProps._meta = { collapsedFrom };

  return wrapIn(next, template.id, "Repeater", repeaterProps, `${template.id}__repeat`);
}

/** Every id in `id`'s subtree, including itself. */
function subtreeIds(tree: FlatTree, id: string): Set<string> {
  const kids = new Map<string, string[]>();
  for (const n of tree.nodes) {
    if (n.parent === null) continue;
    kids.set(n.parent, [...(kids.get(n.parent) ?? []), n.id]);
  }
  const ids = new Set<string>();
  const stack = [id];
  while (stack.length > 0) {
    const nodeId = stack.pop()!;
    if (ids.has(nodeId)) continue;
    ids.add(nodeId);
    for (const child of kids.get(nodeId) ?? []) stack.push(child);
  }
  return ids;
}
