/**
 * Part 1 — Wire format.
 *
 * Trees are emitted and stored FLAT. Recursive JSON schemas are the single
 * biggest cause of structured-output failures, so the agent never emits
 * nesting — it emits a list, and this module is the only thing that knows how
 * to fold it back up.
 *
 * Pure. No I/O.
 */

import { z } from "zod";
import { SCHEMA_VERSION } from "./version.js";

export interface FlatNode {
  id: string;
  parent: string | null;
  idx: number;
  type: string;
  /**
   * The Figma node id. MANDATORY on every node — it is the anchor for the
   * repair loop (diff region -> Figma node) and for attaching `dataRef` in
   * phase 2 without regenerating.
   */
  src: string;
  props: Record<string, unknown>;
}

export interface FlatTree {
  schemaVersion: string;
  nodes: FlatNode[];
}

/** The reified form. Only ever built in memory; never stored, never emitted. */
export interface Node {
  id: string;
  type: string;
  src: string;
  props: Record<string, unknown>;
  children?: Node[];
}

export const flatNodeSchema = z
  .object({
    id: z.string().min(1),
    parent: z.string().min(1).nullable(),
    idx: z.number().int().min(0),
    type: z.string().min(1),
    src: z.string().min(1),
    props: z.record(z.unknown()),
  })
  .strict();

export const flatTreeSchema = z
  .object({
    schemaVersion: z.string(),
    nodes: z.array(flatNodeSchema),
  })
  .strict();

export type ReifyErrorCode =
  | "multi-root"
  | "no-root"
  | "orphan"
  | "cycle"
  | "idx-gap"
  | "duplicate-id"
  | "self-parent";

export class ReifyError extends Error {
  readonly code: ReifyErrorCode;
  readonly nodeIds: string[];

  constructor(code: ReifyErrorCode, message: string, nodeIds: string[] = []) {
    super(message);
    this.name = "ReifyError";
    this.code = code;
    this.nodeIds = nodeIds;
  }
}

/**
 * A node the agent inserted that has no Figma origin — a wrapper it needed for
 * layout that the design did not draw. Kept traceable to the parent it was
 * inserted under so the repair loop can still find its neighbourhood.
 */
export function syntheticSrc(parentSrc: string, n: number): string {
  return `synthetic:${parentSrc}:${n}`;
}

export function isSynthetic(src: string): boolean {
  return src.startsWith("synthetic:");
}

/** Depth-first pre-order, children in `idx` order. */
export function flatten(root: Node, schemaVersion = SCHEMA_VERSION): FlatTree {
  const nodes: FlatNode[] = [];

  const walk = (node: Node, parent: string | null, idx: number): void => {
    nodes.push({ id: node.id, parent, idx, type: node.type, src: node.src, props: node.props });
    (node.children ?? []).forEach((child, i) => walk(child, node.id, i));
  };

  walk(root, null, 0);
  return { schemaVersion, nodes };
}

/**
 * Fold a flat list back into a tree.
 *
 * Rejects rather than repairs: exactly one node with `parent === null`, every
 * other parent resolves, no cycles, and each parent's children carry contiguous
 * `idx` from 0. Gaps are an ERROR, not something to silently compact — a gap
 * means the producer dropped a node it thought it emitted, and compacting it
 * would hide that.
 */
export function reify(flat: FlatTree): Node {
  const byId = new Map<string, FlatNode>();
  for (const node of flat.nodes) {
    if (byId.has(node.id)) {
      throw new ReifyError("duplicate-id", `duplicate node id "${node.id}"`, [node.id]);
    }
    byId.set(node.id, node);
  }

  const roots = flat.nodes.filter((n) => n.parent === null);
  if (roots.length === 0) throw new ReifyError("no-root", "no node has parent === null");
  if (roots.length > 1) {
    throw new ReifyError(
      "multi-root",
      `expected exactly one root, found ${roots.length}: ${roots.map((r) => r.id).join(", ")}`,
      roots.map((r) => r.id),
    );
  }

  const childrenOf = new Map<string, FlatNode[]>();
  for (const node of flat.nodes) {
    if (node.parent === null) continue;
    if (node.parent === node.id) {
      throw new ReifyError("self-parent", `node "${node.id}" is its own parent`, [node.id]);
    }
    if (!byId.has(node.parent)) {
      throw new ReifyError("orphan", `node "${node.id}" references missing parent "${node.parent}"`, [node.id]);
    }
    const list = childrenOf.get(node.parent);
    if (list) list.push(node);
    else childrenOf.set(node.parent, [node]);
  }

  for (const [parent, children] of childrenOf) {
    const sorted = [...children].sort((a, b) => a.idx - b.idx);
    for (const [position, child] of sorted.entries()) {
      if (child.idx !== position) {
        throw new ReifyError(
          "idx-gap",
          `children of "${parent}" must carry contiguous idx from 0; expected ${position} at "${child.id}" but found ${child.idx}`,
          [child.id],
        );
      }
    }
  }

  // Walk from the root marking as we go. Anything unreached sits in a cycle or
  // in a component detached from the root.
  const seen = new Set<string>();
  const build = (node: FlatNode): Node => {
    if (seen.has(node.id)) {
      throw new ReifyError("cycle", `cycle detected at node "${node.id}"`, [node.id]);
    }
    seen.add(node.id);
    const children = (childrenOf.get(node.id) ?? []).slice().sort((a, b) => a.idx - b.idx).map(build);
    const out: Node = { id: node.id, type: node.type, src: node.src, props: node.props };
    if (children.length > 0) out.children = children;
    return out;
  };

  const tree = build(roots[0]!);

  if (seen.size !== flat.nodes.length) {
    const unreached = flat.nodes.filter((n) => !seen.has(n.id)).map((n) => n.id);
    throw new ReifyError("cycle", `${unreached.length} node(s) unreachable from the root: ${unreached.join(", ")}`, unreached);
  }

  return tree;
}

/** Children of `id`, in `idx` order. Cheap enough to call in a loop. */
export function childrenOf(tree: FlatTree, id: string | null): FlatNode[] {
  return tree.nodes.filter((n) => n.parent === id).sort((a, b) => a.idx - b.idx);
}

export function nodeById(tree: FlatTree, id: string): FlatNode | undefined {
  return tree.nodes.find((n) => n.id === id);
}

export function rootOf(tree: FlatTree): FlatNode | undefined {
  return tree.nodes.find((n) => n.parent === null);
}

/** Depth of each node, root = 0. Returns an empty map when the tree is malformed. */
export function depths(tree: FlatTree): Map<string, number> {
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const out = new Map<string, number>();

  const depthOf = (node: FlatNode, guard: Set<string>): number => {
    const cached = out.get(node.id);
    if (cached !== undefined) return cached;
    if (node.parent === null) {
      out.set(node.id, 0);
      return 0;
    }
    if (guard.has(node.id)) return 0;
    guard.add(node.id);
    const parent = byId.get(node.parent);
    const depth = parent ? depthOf(parent, guard) + 1 : 0;
    out.set(node.id, depth);
    return depth;
  };

  for (const node of tree.nodes) depthOf(node, new Set());
  return out;
}
