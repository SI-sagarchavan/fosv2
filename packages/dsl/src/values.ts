/**
 * Part 2 — Value wrappers.
 *
 * Three generics, applied everywhere. The agent learns two shapes and reuses
 * them across every prop, which is what keeps prop count flat as designs
 * multiply.
 *
 * Pure. No I/O.
 */

import type { Breakpoints, TokenRef, TypeToken } from "@fanos/tokens";
import { CATEGORIES } from "@fanos/tokens";

export type { TokenRef };

/**
 * A value the design system has no token for yet.
 *
 * Deliberate, not an oversight: under static-fidelity scope the transpiler must
 * be able to reproduce a frame whose values are not tokenised. Raw values
 * VALIDATE but are COUNTED — driving that count to zero is a design-ops metric,
 * not a build blocker. `_unbound` is required and always `true` so a raw escape
 * can never be mistaken for a plain object at a glance, in a diff, or in a grep.
 */
export interface Raw<T> {
  raw: T;
  _unbound: true;
}

export type Val<T> = TokenRef | Raw<T>;

/**
 * Responsive breakpoint keys, derived from `@fanos/tokens` rather than
 * redeclared. If the tokens package adds a breakpoint, every `Resp<>` in the
 * DSL gains it without an edit here.
 */
export type BreakpointKey = keyof Breakpoints;

export type RespObject<T> = { base: T } & { [K in BreakpointKey]?: T };

/**
 * `Resp<TypeToken>` is deliberately `never`.
 *
 * `@fanos/tokens` already resolves `type.*` per breakpoint inside the token
 * layer — `style: "type.dp_2_regular"` emits different sizes at each viewport on
 * its own. Wrapping it again would produce two competing responsive systems for
 * one value, so the type system refuses it and rule T3 catches it at runtime.
 *
 * The `[T] extends [X]` form is intentional: a naked conditional would
 * distribute over unions and break `Resp<Val<number>>`, which must keep mixed
 * shapes like `{ base: "space.4", md: { raw: 12, _unbound: true } }`.
 */
export type Resp<T> = [T] extends [TypeToken] ? never : T | RespObject<T>;

export type Percent = `${number}%`;

/** `SpaceToken | Raw<number> | \`${number}%\` | "full" | "auto"` */
export type SizeValue = `space.${string}` | Raw<number> | Percent | "full" | "auto";

/** Same as {@link SizeValue} minus the keywords; negatives are allowed. */
export type OffsetValue = `space.${string}` | `-space.${string}` | Raw<number> | Percent;

export type Anchor =
  | "fill"
  | "top-start"
  | "top-center"
  | "top-end"
  | "mid-start"
  | "center"
  | "mid-end"
  | "bottom-start"
  | "bottom-center"
  | "bottom-end";

export const ANCHORS: readonly Anchor[] = [
  "fill",
  "top-start",
  "top-center",
  "top-end",
  "mid-start",
  "center",
  "mid-end",
  "bottom-start",
  "bottom-center",
  "bottom-end",
];

// ---------------------------------------------------------------------------
// Runtime recognisers
// ---------------------------------------------------------------------------

const CATEGORY_ALTERNATION = [...CATEGORIES].join("|");

/**
 * A ref is `<known category>.<leaf>`. Anchoring on the known categories is what
 * lets `surface.nope` be recognised as a *ref that does not resolve* (T1, with
 * suggestions) rather than dismissed as a malformed string.
 */
export const TOKEN_REF_RE = new RegExp(`^(${CATEGORY_ALTERNATION})\\.[A-Za-z0-9_][A-Za-z0-9_.]*$`);

/** Offsets may be negated: `-space.6` shifts a badge stack off the card edge. */
export const SIGNED_TOKEN_REF_RE = new RegExp(`^-?(${CATEGORY_ALTERNATION})\\.[A-Za-z0-9_][A-Za-z0-9_.]*$`);

export const PERCENT_RE = /^-?(?:\d+|\d*\.\d+)%$/;
export const RATIO_RE = /^\d+(?:\.\d+)?\/\d+(?:\.\d+)?$/;
export const SEMVER_REF_RE = /^[A-Za-z][A-Za-z0-9_-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function isTokenRef(value: unknown): value is TokenRef {
  return typeof value === "string" && TOKEN_REF_RE.test(value);
}

export function isSignedTokenRef(value: unknown): value is TokenRef {
  return typeof value === "string" && SIGNED_TOKEN_REF_RE.test(value);
}

/** Strips a leading `-`, so an offset ref can be resolved like any other. */
export function unsignRef(ref: string): string {
  return ref.startsWith("-") ? ref.slice(1) : ref;
}

export function refCategory(ref: string): string | undefined {
  const dot = unsignRef(ref).indexOf(".");
  return dot > 0 ? unsignRef(ref).slice(0, dot) : undefined;
}

export function isRaw(value: unknown): value is Raw<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "_unbound" in value &&
    (value as { _unbound: unknown })._unbound === true &&
    "raw" in value
  );
}

/** A `{ base, md?, lg? }` wrapper rather than a bare value. */
export function isRespObject(value: unknown): value is RespObject<unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "base" in value && !isRaw(value);
}

export function raw<T>(value: T): Raw<T> {
  return { raw: value, _unbound: true };
}

/** Every concrete value inside a `Resp<>`, whether wrapped or bare. */
export function respValues(value: unknown): unknown[] {
  return isRespObject(value) ? Object.values(value) : [value];
}
