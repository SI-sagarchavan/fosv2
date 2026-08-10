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
