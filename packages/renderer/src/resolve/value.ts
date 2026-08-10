/**
 * Value resolution primitives — pure, no React.
 *
 * Token refs become `var(--fos-…)` references (never inlined).
 * Negative token refs become `calc(-1 * var(--fos-…))`.
 * Raw values emit literally and mark raw debt for the caller.
 * Percentages pass through unchanged and are never raw debt.
 */

import { cssVar, cssVarName } from "@fanos/tokens";
import {
  isRaw,
  isRespObject,
  isSignedTokenRef,
  PERCENT_RE,
  unsignRef,
  type RespObject,
} from "@fanos/dsl";

export type CssValue = string | number;

export interface ResolvedValue {
  /** CSS value ready to put on a style declaration. */
  css: string;
  /** True when the source was a Raw escape. */
  raw: boolean;
  /** True when the source was a percentage or keyword like `full`/`auto`. */
  relative: boolean;
}

/** Resolve a single Val / Size / Offset / token / percent / raw to CSS. */
export function resolveValue(value: unknown): ResolvedValue {
  if (value === undefined || value === null) {
    return { css: "", raw: false, relative: false };
  }

  if (isRaw(value)) {
    const raw = value.raw;
    if (typeof raw === "number") return { css: `${raw}px`, raw: true, relative: false };
    return { css: String(raw), raw: true, relative: false };
  }

  if (typeof value === "number") {
    return { css: `${value}px`, raw: false, relative: false };
  }

  if (typeof value !== "string") {
    return { css: String(value), raw: false, relative: false };
  }

  if (value === "full" || value === "auto") {
    return { css: value === "full" ? "100%" : "auto", raw: false, relative: true };
  }

  if (PERCENT_RE.test(value)) {
    return { css: value, raw: false, relative: true };
  }

  if (isSignedTokenRef(value)) {
    const negative = value.startsWith("-");
    const ref = unsignRef(value);
    const v = cssVar(ref);
    return {
      css: negative ? `calc(-1 * ${v})` : v,
      raw: false,
      relative: false,
    };
  }

  // Duration tokens emit as var() too when passed as a bare string.
  return { css: value, raw: false, relative: false };
}

export interface BreakpointValues {
  base: string;
  md?: string;
  lg?: string;
}

/**
 * Resolve a `Resp<T>` into per-breakpoint CSS custom-property values.
 * Bare values become `{ base }`. Never emits media queries — the cascade
 * sheet in `styles.css` promotes `--*-md` / `--*-lg` at the configured floors.
 */
export function resolveResp(value: unknown): {
  values: BreakpointValues;
  rawPaths: string[];
} {
  const rawPaths: string[] = [];

  if (isRespObject(value)) {
    const obj = value as RespObject<unknown>;
    const base = resolveValue(obj.base);
    if (base.raw) rawPaths.push("base");
    const out: BreakpointValues = { base: base.css };
    if (obj.md !== undefined) {
      const md = resolveValue(obj.md);
      if (md.raw) rawPaths.push("md");
      out.md = md.css;
    }
    if (obj.lg !== undefined) {
      const lg = resolveValue(obj.lg);
      if (lg.raw) rawPaths.push("lg");
      out.lg = lg.css;
    }
    return { values: out, rawPaths };
  }

  const single = resolveValue(value);
  if (single.raw) rawPaths.push("");
  return { values: { base: single.css }, rawPaths };
}

/**
 * Apply a responsive value as custom properties + a base property.
 *
 * Emits:
 *   --gap-base: <…>
 *   --gap-md: <…>     (if present)
 *   --gap-lg: <…>     (if present)
 *   gap: var(--gap-base)
 *
 * Global CSS reassigns `gap` at tablet/desktop from the `-md`/`-lg` vars.
 */
export function applyRespProp(
  style: Record<string, string>,
  cssProp: string,
  varStem: string,
  value: unknown,
  dataAttrs: Record<string, string>,
  propPath: string,
): void {
  if (value === undefined) return;
  const { values, rawPaths } = resolveResp(value);
  style[`--${varStem}-base`] = values.base;
  if (values.md !== undefined) style[`--${varStem}-md`] = values.md;
  if (values.lg !== undefined) style[`--${varStem}-lg`] = values.lg;
  style[cssProp] = `var(--${varStem}-base)`;
  for (const bp of rawPaths) {
    const path = bp ? `${propPath}.${bp}` : propPath;
    markRaw(dataAttrs, path);
  }
}

export function markRaw(dataAttrs: Record<string, string>, propPath: string): void {
  const existing = dataAttrs["data-fos-raw"];
  dataAttrs["data-fos-raw"] = existing ? `${existing} ${propPath}` : propPath;
}

/** Duration token or Raw → CSS time value (var or ms). */
export function resolveDuration(value: unknown): ResolvedValue {
  if (isRaw(value) && typeof value.raw === "number") {
    return { css: `${value.raw}ms`, raw: true, relative: false };
  }
  if (typeof value === "string" && value.startsWith("duration.")) {
    return { css: `var(${cssVarName(value)})`, raw: false, relative: false };
  }
  return resolveValue(value);
}
