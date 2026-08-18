/**
 * Reading the designer's declaration off the component names.
 *
 * The one classification that is not in the IR is what a frame IS: a button and
 * a rounded box with a label are the same geometry, and the difference — that
 * one is pressable — is something Figma has nowhere to record. So the designer
 * records it the only place they can, in the name of the component master, and
 * this is what reads it.
 *
 * The convention is a PREFIX, not a bare name, and that is deliberate. Figma
 * autogenerates `Image`, `Line`, `Vector`, `Component` and `Frame`, which is
 * exactly why `ids.ts` treats them as noise — so a component called `Image`
 * cannot be distinguished from a layer Figma named itself. `atom_image` can.
 * Southern Brave already names this way: `atom_button`, `atom_button_master`,
 * `atom_icon_arrow_up_right`.
 *
 * The result is keyed by `componentKey` rather than by name, because that is
 * the identity that survives the rename the name does not. The name proposes;
 * the key is what the entry is stored against.
 *
 * PURE. Same document in, same map out.
 */

import type { FrameIRDocument, FrameIRNode } from "@fanos/surface-canvas/ir";
import type { DslType, PrimitiveMap } from "./classify.js";

/** The prefix that turns a layer name into a declaration. */
export const PRIMITIVE_PREFIX = "atom";

/**
 * Names that declare a primitive, and what they declare.
 *
 * Deliberately short. A type belongs here only once the renderer can draw it
 * AND the compiler can derive its props — anything else declares a node that
 * renders as a diagnostic placeholder, which is worse than the frames it
 * replaced. It grows one primitive at a time.
 */
const DECLARABLE: Readonly<Record<string, DslType>> = {
  button: "Button",
};

/**
 * The type a component name declares, if any.
 *
 * Matches the FIRST segment after the prefix, so `atom_button` and
 * `atom_button_master` both say Button — which is correct, and harmless: the
 * outer instance is classified first and subsumes the master it wraps.
 */
export function declaredType(name: string): DslType | undefined {
  const m = /^atom[\s_-]+([a-z]+)/i.exec(name.trim());
  return m ? DECLARABLE[m[1]!.toLowerCase()] : undefined;
}

/**
 * Every component in the document whose name declares a primitive.
 *
 * Instances carry the master's name, so walking the document finds the
 * declaration without needing the master's own page to have been exported.
 */
export function primitivesFromNames(doc: FrameIRDocument): PrimitiveMap {
  const out: Record<string, DslType> = {};

  (function walk(n: FrameIRNode): void {
    const key = n.componentKey;
    if (key && out[key] === undefined) {
      const type = declaredType(n.name);
      if (type) out[key] = type;
    }
    for (const child of n.children ?? []) walk(child);
  })(doc.root);

  return out;
}
