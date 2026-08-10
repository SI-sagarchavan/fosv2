import type { CSSProperties } from "react";
import type { CssProperties } from "../resolve/anchor.js";

/**
 * Convert our plain string-keyed style bag to a React CSSProperties object.
 * Custom properties (`--gap-base`) are valid; React accepts them on style.
 */
export function styleToReact(style: CssProperties): CSSProperties {
  return style as CSSProperties;
}
