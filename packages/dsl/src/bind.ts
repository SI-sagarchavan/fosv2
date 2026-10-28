/**
 * Applying a binding plan — the mechanical half of authoring.
 *
 * A plan says which nodes carry data and which siblings are one component
 * repeated. It cannot be derived from a tree (see `collapse.ts`), so it is an
 * input; what happens once you have one is arithmetic, and this is it.
 *
 * KEYED BY `src`, never by node id. Node ids come from Figma layer names —
 * `ids.ts` in @fanos/compile slugs the name and adds a numeric suffix on
 * collision — so a designer renaming a layer, reordering siblings, or editing
 * placeholder copy silently moves them. `src` is the Figma node id and survives
 * all three. The news grid makes the trap concrete: a node called
 * `over_400_players_will_be_available_in_th` whose content is "Chris Jordan saw
 * it through late on", because the copy was edited and the layer name was not.
 *
 * DRIFT IS REPORTED, NOT THROWN. One plan is meant to outlive many compiles of
 * the same frame, and a frame changes: nodes disappear, and the same Figma node
 * can compile to a different DSL type between exports — the news grid's button
 * is a `Button` primitive in one and a plain `Stack` in another, and `label`
 * exists on only one of them. Writing it anyway produces a tree that fails S12
 * with a prop nobody put there on purpose. So entries that cannot land are
 * skipped and named, and what could not be applied is the review queue.
 *
 * PURE. No filesystem, no process, no clock.
 */

import type { FlatNode, FlatTree } from "./flat.js";
import { allFields, nodeSpec } from "./nodes/index.js";
import { proposeCollapse } from "./collapse.js";
import { applyCollapse, setProp, TreeOpError } from "./ops.js";
import { hasRef } from "./binding.js";

export interface PlanBinding {
  /** The Figma node id, NOT the DSL node id. */
  src: string;
  prop: string;
  /** Dotted path, relative to the document — or to the item inside a collapse. */
  path: string;
}

export interface PlanCollapse {
  /** Dotted path to the source list, e.g. `news.items`. */
  over: string;
  /** What one item is called inside the template, e.g. `article`. */
  as: string;
  slice?: [number, number];
  /** The instances, by `src`, in document order. The first is the template. */
  members: string[];
  /** Bound inside the template, so paths are relative to one item. */
  fields?: PlanBinding[];
}

/**
 * A literal prop the binding needs that is not a `{path}`.
 *
 * Binding real data is more than pointing text at fields. A CAST thumbnail is
 * `/static-assets/media/{{RATIO}}-<file>`, and the crop the CDN cuts comes from
 * the Image's `ratio` — which a compiled tree never sets on a fill image, so a
 * 1:1 card would be served the 16:9 default. And a video badge is only a
 * binding once it has a `when`. Applied after `bind` and `collapse`, so it can
 * reach a Repeater's template and test the item by its alias.
 */
export interface PlanSet {
  src: string;
  prop: string;
  value: unknown;
}

export interface BindingPlan {
  bind?: PlanBinding[];
  collapse?: PlanCollapse[];
  set?: PlanSet[];
  /** Free text. Ignored here; it travels with the plan for whoever reads it. */
  note?: string;
}

export type DriftReason = "missing" | "wrong-type" | "not-a-run" | "ambiguous";

export interface Drift {
  reason: DriftReason;
  src: string;
  message: string;
}

export interface BindResult {
  tree: FlatTree;
  /** How many props the plan actually wrote. */
  bound: number;
  /** How many sibling runs it folded. */
  collapsed: number;
  /** What it could not apply, and why. The review queue. */
  drift: Drift[];
}

export function applyBindingPlan(tree: FlatTree, plan: BindingPlan): BindResult {
  const drift: Drift[] = [];
  let next = tree;
  let bound = 0;
  let collapsed = 0;

  /** The node a `src` names in THIS compile, or null if the frame lost it. */
  const find = (from: FlatTree, src: string): FlatNode | null => {
    const hits = from.nodes.filter((n) => n.src === src);
    if (hits.length > 1) {
      drift.push({
        reason: "ambiguous",
        src,
        message: `${hits.length} nodes claim src ${src}; the plan cannot say which`,
      });
      return null;
    }
    return hits[0] ?? null;
  };

  for (const entry of plan.bind ?? []) {
    const node = find(next, entry.src);
    if (!node) {
      drift.push({
        reason: "missing",
        src: entry.src,
        message: `src ${entry.src} is not in this tree — nothing bound to ${entry.path}`,
      });
      continue;
    }
    if (!accepts(node.type, entry.prop)) {
      drift.push({
        reason: "wrong-type",
        src: entry.src,
        message: `src ${entry.src} compiled to a ${node.type}, which has no "${entry.prop}" — ${entry.path} not bound`,
      });
      continue;
    }
    next = setProp(next, node.id, entry.prop, `{${entry.path}}`);
    bound += 1;
  }

  for (const group of plan.collapse ?? []) {
    const members = group.members.map((src) => find(next, src));
    const templateNode = members[0];
    if (members.some((m) => m === null) || !templateNode) {
      drift.push({
        reason: "missing",
        src: group.members[0] ?? "",
        message: `not every member of the ${group.over} run is in this tree — not collapsed`,
      });
      continue;
    }

    /**
     * The plan says WHICH siblings; `proposeCollapse` still has to agree they
     * are the same shape. A plan that names three nodes the signature does not
     * group would fold a card that is not a repeat — losing whatever made it
     * different — so disagreement is drift, not something to push through.
     */
    const proposal = proposeCollapse(next).find((p) => p.templateId === templateNode.id);
    const memberIds = (members as FlatNode[]).map((m) => m.id);
    if (!proposal || proposal.memberIds.join() !== memberIds.join()) {
      drift.push({
        reason: "not-a-run",
        src: group.members[0] ?? "",
        message: proposal
          ? `the plan's ${group.over} members ${memberIds.join(", ")} do not match the detected run ${proposal.memberIds.join(", ")}`
          : `${templateNode.id} is not a detected run in this tree — not collapsed`,
      });
      continue;
    }

    const fieldMap: Record<string, { prop: string; path: string }> = {};
    for (const field of group.fields ?? []) {
      const node = find(next, field.src);
      if (!node) {
        drift.push({
          reason: "missing",
          src: field.src,
          message: `src ${field.src} is not in this tree — nothing bound to ${group.as}.${field.path}`,
        });
        continue;
      }
      if (!accepts(node.type, field.prop)) {
        drift.push({
          reason: "wrong-type",
          src: field.src,
          message: `src ${field.src} compiled to a ${node.type}, which has no "${field.prop}" — ${group.as}.${field.path} not bound`,
        });
        continue;
      }
      fieldMap[node.id] = { prop: field.prop, path: field.path };
    }

    try {
      next = applyCollapse(
        next,
        { parentId: proposal.parentId, memberIds, templateId: templateNode.id },
        {
          over: group.over,
          as: group.as,
          ...(group.slice ? { slice: group.slice } : {}),
          fieldMap,
        },
      );
      bound += Object.keys(fieldMap).length;
      collapsed += 1;
    } catch (err) {
      // A rejected op is the plan disagreeing with the tree, which is drift by
      // another name — never a reason to hand back a half-applied tree.
      drift.push({
        reason: "not-a-run",
        src: group.members[0] ?? "",
        message: err instanceof TreeOpError ? err.message : String(err),
      });
    }
  }

  for (const entry of plan.set ?? []) {
    const node = find(next, entry.src);
    if (!node) {
      drift.push({
        reason: "missing",
        src: entry.src,
        message: `src ${entry.src} is not in this tree — "${entry.prop}" not set`,
      });
      continue;
    }
    if (!accepts(node.type, entry.prop)) {
      drift.push({
        reason: "wrong-type",
        src: entry.src,
        message: `src ${entry.src} compiled to a ${node.type}, which has no "${entry.prop}" — not set`,
      });
      continue;
    }
    next = setProp(next, node.id, entry.prop, entry.value);
  }

  return { tree: next, bound, collapsed, drift };
}

/** Does this node type declare that prop at all? Guards the S12 case above. */
function accepts(type: string, prop: string): boolean {
  const spec = nodeSpec(type);
  if (!spec) return false;
  return prop in allFields(spec);
}

/**
 * Does this tree ask for data at all?
 *
 * A compiled tree keeps Figma's literal characters, so handing it a data
 * document changes nothing — the reason `?data=` on a fresh run looks broken.
 * Cheap enough to call before deciding whether a plan needs applying.
 */
export function hasBindings(tree: FlatTree): boolean {
  return tree.nodes.some((n) => Object.values(n.props).some(hasRef));
}
