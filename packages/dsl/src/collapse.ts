/**
 * Collapse proposals: "these N siblings are one component, N times."
 *
 * Proposals ONLY. Nothing in this file changes a tree, and nothing downstream
 * of it applies a proposal on its own — `applyCollapse` takes a binding as an
 * argument because it cannot be derived. Whether six card slots are one
 * data-driven list or six deliberate placements is a statement about the CMS
 * behind the page, and the tree does not contain it: a fixtures board with six
 * identical slots and an editorial grid with six articles look exactly alike
 * from here.
 *
 * What CAN be derived is everything else — which siblings are structurally
 * identical, how many nodes that is worth, whether they sit in a row, and which
 * content props differ across them. Facts, all of them; there is deliberately
 * no score, because a number between 0 and 1 invites a threshold and every
 * proposal needs the same yes. That last field is the useful one: the
 * props that vary between instances are, by construction, exactly the props the
 * signature excluded, and they are the shape of the item contract a binder
 * needs to propose a field mapping instead of asking blind.
 *
 * PURE. No filesystem, no process, no clock.
 */

import type { FlatNode, FlatTree } from "./flat.js";
import {
  CONTENT_PROPS,
  IDENTITY_PROPS,
  TYPE_EXCLUSIONS,
  subtreeSignatures,
} from "./subtree-signature.js";

export interface VaryingContent {
  prop: string;
  /** The distinct values found, in member order, first occurrence wins. */
  values: string[];
}

export interface CollapseProposal {
  parentId: string;
  signature: string;
  /** In `idx` order, which is document order. */
  memberIds: string[];
  /** `memberIds[0]` — the first instance the design drew. */
  templateId: string;
  count: number;
  nodesPerMember: number;
  /** Nodes the removal takes out. The inserted Repeater is not netted off. */
  nodesSaved: number;
  contiguous: boolean;
  /**
   * Per template-relative node, every content prop that differs across the
   * members. Keyed by the node id IN THE TEMPLATE, so a binder can name the
   * node it is about to bind, and an ARRAY because one node can vary in more
   * than one prop — an Image's `src` and `alt` routinely both do.
   *
   * EMPTY IS INFORMATION, not a failure. On the news grid all three trailing
   * cards carry the same pasted copy, so nothing varies and field discovery
   * cannot come from variation — which is the answer a binder needs before it
   * starts guessing field names from three identical strings.
   */
  varyingContent: Record<string, VaryingContent[]>;
}

export function proposeCollapse(tree: FlatTree): CollapseProposal[] {
  const signatures = subtreeSignatures(tree);
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));

  const kids = new Map<string, FlatNode[]>();
  for (const node of tree.nodes) {
    if (node.parent === null) continue;
    const list = kids.get(node.parent);
    if (list) list.push(node);
    else kids.set(node.parent, [node]);
  }
  for (const list of kids.values()) list.sort((a, b) => a.idx - b.idx);

  const root = tree.nodes.find((n) => n.parent === null);
  const proposals: CollapseProposal[] = [];

  for (const [parentId, siblings] of kids) {
    const groups = new Map<string, FlatNode[]>();
    for (const child of siblings) {
      const sig = signatures.get(child.id);
      if (sig === undefined) continue;
      const list = groups.get(sig);
      if (list) list.push(child);
      else groups.set(sig, [child]);
    }

    for (const [signature, members] of groups) {
      if (members.length < 2) continue;

      const contiguous = isContiguous(members);

      /**
       * Two identical siblings that are NOT next to each other are far more
       * often coincidence than a list — a logo top-left and the same logo
       * bottom-right, two identical dividers either side of a block. A run of
       * three is evidence; a scattered pair is a shape.
       */
      if (!contiguous && members.length === 2) continue;

      /**
       * The root's entire child set is the page, not a list. Collapsing it
       * would say every band on the page is one band repeated, which is true
       * of the shapes and false of the page.
       */
      if (root && parentId === root.id && members.length === siblings.length) continue;

      const subtrees = members.map((m) => subtreeOf(kids, byId, m.id));

      // A member that already repeats is not an instance to fold; folding it
      // would nest a Repeater inside a Repeater over an undeclared list.
      if (subtrees.some((nodes) => nodes.some((n) => n.type === "Repeater"))) continue;

      const template = members[0]!;
      const nodesPerMember = subtrees[0]!.length;

      proposals.push({
        parentId,
        signature,
        memberIds: members.map((m) => m.id),
        templateId: template.id,
        count: members.length,
        nodesPerMember,
        nodesSaved: (members.length - 1) * nodesPerMember,
        contiguous,
        varyingContent: findVaryingContent(subtrees),
      });
    }
  }

  /**
   * Biggest saving first, then by id so the order never depends on Map
   * iteration. A proposal list a human works down should not reshuffle between
   * two runs of the same input.
   */
  return proposals.sort(
    (a, b) => b.nodesSaved - a.nodesSaved || (a.parentId < b.parentId ? -1 : a.parentId > b.parentId ? 1 : 0),
  );
}

/** Members occupy consecutive `idx` slots among their siblings. */
function isContiguous(members: readonly FlatNode[]): boolean {
  for (let i = 1; i < members.length; i++) {
    if (members[i]!.idx !== members[i - 1]!.idx + 1) return false;
  }
  return true;
}

/** A subtree in a stable pre-order, children by `idx`. Template order. */
function subtreeOf(kids: Map<string, FlatNode[]>, byId: Map<string, FlatNode>, id: string): FlatNode[] {
  const out: FlatNode[] = [];
  const stack: string[] = [id];
  while (stack.length > 0) {
    const nodeId = stack.pop()!;
    const node = byId.get(nodeId);
    if (!node) continue;
    out.push(node);
    const children = kids.get(nodeId) ?? [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!.id);
  }
  return out;
}

/**
 * Which content props differ across the members, by template position.
 *
 * The members hash the same, so their subtrees are the same shape and walk in
 * lockstep — position `i` in one is position `i` in every other. Only props the
 * SIGNATURE EXCLUDED can possibly differ, which is why this reads its prop list
 * from the same module: anything else that differed would be a bug in the hash,
 * and looking for it here would hide that.
 */
function findVaryingContent(subtrees: FlatNode[][]): Record<string, VaryingContent[]> {
  const out: Record<string, VaryingContent[]> = {};
  const template = subtrees[0]!;

  for (let i = 0; i < template.length; i++) {
    const node = template[i]!;
    const varying: VaryingContent[] = [];

    for (const prop of contentPropsOf(node)) {
      const values: string[] = [];
      for (const subtree of subtrees) {
        const text = stringify(subtree[i]?.props[prop]);
        if (!values.includes(text)) values.push(text);
      }
      if (values.length >= 2) varying.push({ prop, values });
    }

    if (varying.length > 0) out[node.id] = varying;
  }

  return out;
}

/** The prop names on this node that a signature ignores because they are content. */
function contentPropsOf(node: FlatNode): string[] {
  const typed = TYPE_EXCLUSIONS[node.type] ?? [];
  return Object.keys(node.props).filter(
    (key) => !IDENTITY_PROPS.has(key) && (CONTENT_PROPS.has(key) || typed.includes(key)),
  );
}

function stringify(value: unknown): string {
  return value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
}
