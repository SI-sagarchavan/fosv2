/**
 * Render context — passed as a prop tree rather than React context, because
 * every component is a Server Component and we want zero client boundaries.
 */

import type { AssetContext } from "@fanos/tokens";
import type { DataBag } from "./resolve/data.js";

export interface RenderConfig {
  /** Binding data for `{path}` interpolation. */
  data?: DataBag;
  /** Asset CDN resolution. Local dev: LOCAL_ASSET_CONTEXT. */
  assets?: AssetContext;
  /** Theme slug for data-fos-theme when CSS is scoped by attr. */
  themeSlug?: string;
}

export interface NodeRenderContext extends RenderConfig {
  /** Parent is a Stack — enables size.w:"full" → flex:1 1 0. */
  flexChild?: boolean;
  /**
   * True only when the parent Stack runs HORIZONTALLY.
   *
   * `size.w: "full"` means "share the free space" on a row (the stat strip's
   * equal columns) but plain `width: 100%` on a column — there `flex: 1 1 0`
   * sizes the MAIN axis and collapses the child's HEIGHT to zero, which is what
   * made the news card's 16:9 thumbnail vanish.
   */
  flexRow?: boolean;
  /** Parent is an Overlay — children may use place.anchor. */
  overlayChild?: boolean;
}
