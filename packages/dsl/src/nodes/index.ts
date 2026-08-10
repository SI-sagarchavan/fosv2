/**
 * The node registry — the single list every consumer walks.
 */

import type { Fields } from "../field.js";
import { universalFields } from "../universal.js";
import { STRUCTURAL_NODES, type NodeSpec } from "./structural.js";
import { LEAF_NODES } from "./leaves.js";

export type { NodeSpec };
export { STRUCTURAL_NODES, LEAF_NODES };

export const NODE_SPECS: readonly NodeSpec[] = [...STRUCTURAL_NODES, ...LEAF_NODES];

export const NODE_TYPES: readonly string[] = NODE_SPECS.map((s) => s.type);

const BY_TYPE = new Map(NODE_SPECS.map((s) => [s.type, s]));

export function nodeSpec(type: string): NodeSpec | undefined {
  return BY_TYPE.get(type);
}

export function isNodeType(type: string): boolean {
  return BY_TYPE.has(type);
}

/**
 * A node's full prop surface: its own fields plus the universal ones.
 *
 * A fragment gets no universal LAYOUT props — that is the rule S5 enforces, and
 * building its schema without them means an offending tree fails the parser as
 * well as the validator.
 */
export function allFields(spec: NodeSpec): Fields {
  if (!spec.fragment) return { ...universalFields, ...spec.fields };
  const { surface: _surface, space: _space, size: _size, place: _place, ...rest } = universalFields;
  return { ...rest, ...spec.fields };
}
