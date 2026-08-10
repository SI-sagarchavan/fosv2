/**
 * Package configuration. Everything here is a build-time decision that the
 * token file cannot answer for itself.
 */

import type { Breakpoint } from "./types.js";

export interface Breakpoints {
  /** Tablet floor, in px. */
  md: number;
  /** Desktop floor, in px. */
  lg: number;
}

export interface TokensConfig {
  /**
   * Breakpoints are NOT in the token file — the export has three typography
   * sets and no widths to hang them on. They are a property of the product, so
   * they live here and are emitted as vars for JS consumers.
   */
  breakpoints: Breakpoints;
  /** `root` -> `:root`; `attr` -> `[data-fos-theme="<slug>"]`. */
  scope: "root" | "attr";
  /**
   * Emit type styles that exist on only some breakpoints, falling back to the
   * nearest neighbour. Off by default: the generated `TypeToken` union has to be
   * safe at every viewport, and a partial style is a runtime 404 waiting to
   * happen.
   */
  allowPartialTypography: boolean;
}

export const DEFAULT_BREAKPOINTS: Breakpoints = { md: 768, lg: 1280 };

export const DEFAULT_CONFIG: TokensConfig = {
  breakpoints: DEFAULT_BREAKPOINTS,
  scope: "root",
  allowPartialTypography: false,
};

export function resolveConfig(partial: Partial<TokensConfig> = {}): TokensConfig {
  return {
    breakpoints: { ...DEFAULT_BREAKPOINTS, ...(partial.breakpoints ?? {}) },
    scope: partial.scope ?? DEFAULT_CONFIG.scope,
    allowPartialTypography: partial.allowPartialTypography ?? DEFAULT_CONFIG.allowPartialTypography,
  };
}

/** Minimum width at which a breakpoint's values apply. `mobile` is the base, so 0. */
export function breakpointMinWidth(bp: Breakpoint, breakpoints: Breakpoints): number {
  switch (bp) {
    case "mobile":
      return 0;
    case "tablet":
      return breakpoints.md;
    case "desktop":
      return breakpoints.lg;
  }
}
