/**
 * Part 7 — Docs emission.
 *
 * Generated from the same field descriptors as the types and the JSON Schema, so
 * the documentation cannot describe a prop the validator does not accept.
 */

import { docTypeOf, type Fields } from "../field.js";
import { allFields, LEAF_NODES, NODE_SPECS, STRUCTURAL_NODES } from "../nodes/index.js";
import { universalFields } from "../universal.js";
import { SCHEMA_VERSION } from "../version.js";

function table(fields: Fields): string[] {
  const rows = Object.entries(fields);
  if (rows.length === 0) return ["_No node-specific props — universal props only._"];
  const out = ["| prop | type | required | notes |", "| --- | --- | --- | --- |"];
  for (const [name, def] of rows) {
    const type = docTypeOf(def).replace(/\|/g, "\\|");
    out.push(`| \`${name}\` | \`${type}\` | ${def.optional ? "" : "yes"} | ${def.doc ?? ""} |`);
  }
  return out;
}

export function emitDocs(): string {
  const out: string[] = [];

  out.push("# FanOS SDUI vocabulary");
  out.push("");
  out.push(`Generated from \`@fanos/dsl\`. Schema version \`${SCHEMA_VERSION}\`.`);
  out.push("");
  out.push(`${NODE_SPECS.length} node types: ${STRUCTURAL_NODES.length} structural, ${LEAF_NODES.length} leaves.`);
  out.push("");

  out.push("## Universal props");
  out.push("");
  out.push("Carried by every node type except where a fragment drops them.");
  out.push("");
  out.push(...table(universalFields));
  out.push("");

  for (const group of [
    { title: "Structural nodes", specs: STRUCTURAL_NODES },
    { title: "Leaves", specs: LEAF_NODES },
  ]) {
    out.push(`## ${group.title}`);
    out.push("");
    for (const spec of group.specs) {
      out.push(`### ${spec.type}`);
      out.push("");
      out.push(spec.doc);
      out.push("");
      if (spec.fragment) {
        out.push(
          "**Fragment.** Emits its children into the parent's layout and carries no `surface`, `space`, `size` or `place` props.",
        );
        out.push("");
        out.push(...table(allFields(spec)));
      } else {
        out.push(...table(spec.fields));
      }
      out.push("");
    }
  }

  return `${out.join("\n").trimEnd()}\n`;
}
