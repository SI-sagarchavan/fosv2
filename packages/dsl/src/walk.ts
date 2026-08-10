/**
 * Descends a node's props against its field descriptors, handing every concrete
 * leaf value to a visitor with the path that produced it.
 *
 * One walker serves the token checks (T1/T2/T3/T5), the breakpoint check (T4)
 * and every quality metric (Q1–Q5). They must agree about what counts as a
 * value, so they share the traversal instead of each writing their own.
 *
 * Pure. No I/O.
 */

import type { Field, FieldType, Fields } from "./field.js";
import { isRespObject } from "./values.js";

export interface LeafVisit {
  /** Dotted prop path, e.g. `place.offset.inline` or `space.p`. */
  path: string;
  value: unknown;
  type: FieldType;
  /** Set when the value came from a responsive wrapper key. */
  breakpoint?: string;
  /** True when the declared field is wrapped in `Resp<>`. */
  responsive: boolean;
}

export interface RespVisit {
  path: string;
  keys: string[];
  /** The declared field, so a caller can tell "must not be responsive" apart. */
  field: Field;
}

export interface WalkHandlers {
  leaf?: (visit: LeafVisit) => void;
  /** Called once per `{ base, … }` wrapper actually present in the data. */
  resp?: (visit: RespVisit) => void;
  /** A prop present in the data with no matching descriptor. */
  unknown?: (path: string, value: unknown) => void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function walkType(type: FieldType, value: unknown, path: string, handlers: WalkHandlers, responsive: boolean, breakpoint?: string): void {
  switch (type.k) {
    case "object": {
      if (!isPlainObject(value)) return;
      walkFields(type.fields, value, path, handlers);
      return;
    }
    case "array": {
      if (!Array.isArray(value)) return;
      value.forEach((item, i) => walkType(type.of, item, `${path}[${i}]`, handlers, responsive, breakpoint));
      return;
    }
    case "union": {
      // A union of composites (Tabs.options) still needs descending. Try each
      // member; the ones that do not fit contribute nothing.
      for (const member of type.of) {
        if (member.k === "object" || member.k === "array") {
          walkType(member, value, path, handlers, responsive, breakpoint);
        }
      }
      handlers.leaf?.({ path, value, type, responsive, ...(breakpoint ? { breakpoint } : {}) });
      return;
    }
    default:
      handlers.leaf?.({ path, value, type, responsive, ...(breakpoint ? { breakpoint } : {}) });
  }
}

function walkField(fieldDef: Field, value: unknown, path: string, handlers: WalkHandlers): void {
  if (value === undefined) return;

  if (fieldDef.resp && isRespObject(value)) {
    handlers.resp?.({ path, keys: Object.keys(value), field: fieldDef });
    for (const [key, inner] of Object.entries(value)) {
      walkType(fieldDef.type, inner, path, handlers, true, key === "base" ? undefined : key);
    }
    return;
  }

  // A Resp wrapper on a field NOT declared responsive is still reported, so T3
  // can see it rather than the walker silently treating it as a plain object.
  if (!fieldDef.resp && isRespObject(value)) {
    handlers.resp?.({ path, keys: Object.keys(value), field: fieldDef });
    return;
  }

  walkType(fieldDef.type, value, path, handlers, fieldDef.resp === true);
}

export function walkFields(fields: Fields, props: Record<string, unknown>, prefix: string, handlers: WalkHandlers): void {
  for (const [name, value] of Object.entries(props)) {
    const path = prefix ? `${prefix}.${name}` : name;
    const fieldDef = fields[name];
    if (!fieldDef) {
      handlers.unknown?.(path, value);
      continue;
    }
    walkField(fieldDef, value, path, handlers);
  }
}

export function walkProps(fields: Fields, props: Record<string, unknown>, handlers: WalkHandlers): void {
  walkFields(fields, props, "", handlers);
}
