/**
 * Style resolver — pure, no React.
 *
 * Maps every universal DSL prop (and Stack layout props) to CSS custom
 * properties or utility classes. Token refs become `var()` references so
 * tenant re-theming works without regenerating trees.
 */

import { cssClassName, cssVar, type AssetContext } from "@fanos/tokens";
import { resolveAnchor, type CssProperties, type PlaceInput } from "./anchor.js";
import {
  applyRespProp,
  markRaw,
  resolveDuration,
  resolveValue,
} from "./value.js";

export interface StyleContext {
  /** True when this node is a direct child of a Stack (flex item). */
  flexChild?: boolean;
  /** Asset CDN context for surface/image resolution (optional here). */
  assets?: AssetContext;
  /**
   * When true, `size.w: "full"` on a flex child becomes `flex: 1 1 0`
   * rather than `width: 100%`. The fixture's stat groups depend on this.
   */
  flexGrowFull?: boolean;
  /**
   * True only when the parent Stack runs HORIZONTALLY. `size.w: "full"` means
   * "share the free space" on a row, but plain `width: 100%` on a column —
   * `flex: 1 1 0` there sizes the MAIN axis and zeroes the child's height.
   */
  flexRow?: boolean;
  /**
   * `align` is spelled the same on Stack and on Text but means different
   * things: flex cross-axis on a Stack, `text-align` on a Text. Without this
   * flag every aligned Text silently becomes `display: flex` and never gets
   * the text-align it asked for.
   */
  alignIsTextAlign?: boolean;
}

export interface ResolvedNodeStyle {
  className: string;
  style: CssProperties;
  dataAttrs: Record<string, string>;
}

/** Text `align` — logical, so start/end follow writing direction. */
const TEXT_ALIGN_MAP: Record<string, string> = {
  start: "start",
  center: "center",
  end: "end",
};

const ALIGN_MAP: Record<string, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  stretch: "stretch",
  baseline: "baseline",
};

const JUSTIFY_MAP: Record<string, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  between: "space-between",
  around: "space-around",
  evenly: "space-evenly",
};

/**
 * Resolve universal + layout props on a node into className / style / dataAttrs.
 *
 * `props` is the node's props bag as stored on the flat tree. Node-specific
 * props (Text.content, Image.src, …) are ignored here — components own those.
 */
export function resolveNode(
  props: Record<string, unknown>,
  ctx: StyleContext = {},
): ResolvedNodeStyle {
  const classes = new Set<string>(["fos-node"]);
  const style: CssProperties = {};
  const dataAttrs: Record<string, string> = {};

  // --- surface -----------------------------------------------------------
  const surface = props.surface;
  if (typeof surface === "string" && surface.startsWith("surface.")) {
    const leaf = surface.slice("surface.".length);
    classes.add(cssClassName("surface", leaf));
  } else if (surface && typeof surface === "object") {
    // Resp surface — apply base class; md/lg swapped via data attr if needed.
    const base = (surface as { base?: string }).base;
    if (typeof base === "string" && base.startsWith("surface.")) {
      classes.add(cssClassName("surface", base.slice("surface.".length)));
    }
  }

  // --- clip ---------------------------------------------------------------
  // Figma's `clipsContent`. Deliberate overflow is a design device, not an
  // accident: the fixture row is 235px inside a 227px shell so the cards bleed
  // and get cut rather than leaving a strip of shell colour showing.
  if (props.clip === true) {
    style.overflow = "hidden";
    dataAttrs["data-fos-clip"] = "true";
  }

  // --- space (padding) ---------------------------------------------------
  const space = props.space as Record<string, unknown> | undefined;
  if (space) {
    mapSpace(space, style, dataAttrs);
  }

  // --- size --------------------------------------------------------------
  const size = props.size as Record<string, unknown> | undefined;
  if (size) {
    mapSize(size, style, dataAttrs, ctx);
  }

  // --- place (Overlay children) ------------------------------------------
  const place = props.place as PlaceInput | undefined;
  if (place?.anchor) {
    Object.assign(style, resolveAnchor(place));
    if (place.z !== undefined) {
      // place.z is an explicit override only — rare enough to warrant a warning
      // at render time; the data attr lets tests assert it.
      dataAttrs["data-fos-z-override"] = String(place.z);
    }
  }

  // --- reveal ------------------------------------------------------------
  if (typeof props.reveal === "string" && props.reveal !== "none") {
    classes.add(`fos-reveal-${props.reveal}`);
  }
  if (props.revealDelay !== undefined) {
    const d = resolveDuration(props.revealDelay);
    style["--reveal-delay"] = d.css;
    if (d.raw) markRaw(dataAttrs, "revealDelay");
  }

  // --- Text alignment ----------------------------------------------------
  // Handled before the layout branch so an aligned Text is never mistaken for
  // a Stack. Logical values: `start`/`end` follow writing direction, which is
  // what the RTL story needs.
  if (ctx.alignIsTextAlign && props.align !== undefined) {
    mapEnumResp(style, "textAlign", "text-align", props.align, TEXT_ALIGN_MAP, dataAttrs, "align");
  }

  // --- Stack layout props (harmless if absent) ---------------------------
  const alignIsLayout = !ctx.alignIsTextAlign && props.align !== undefined;
  if (props.direction !== undefined || props.gap !== undefined || alignIsLayout) {
    classes.add("fos-stack");
    style.display = "flex";

    if (props.direction !== undefined) {
      // React style keys are camelCase; the cascade sheet reads the CSS vars.
      const dir = props.direction;
      if (typeof dir === "string") {
        style.flexDirection = dir;
      } else if (dir && typeof dir === "object" && "base" in dir) {
        const o = dir as { base: string; md?: string; lg?: string };
        style["--flex-direction-base"] = o.base;
        if (o.md) style["--flex-direction-md"] = o.md;
        if (o.lg) style["--flex-direction-lg"] = o.lg;
        style.flexDirection = "var(--flex-direction-base)";
      }
    } else {
      style.flexDirection = "column";
    }

    if (props.gap !== undefined) {
      applyRespProp(style, "gap", "gap", props.gap, dataAttrs, "gap");
    }

    if (alignIsLayout) {
      mapEnumResp(style, "alignItems", "align-items", props.align, ALIGN_MAP, dataAttrs, "align");
    }

    if (props.justify !== undefined) {
      mapEnumResp(
        style,
        "justifyContent",
        "justify-content",
        props.justify,
        JUSTIFY_MAP,
        dataAttrs,
        "justify",
      );
    }

    if (props.wrap === true) style.flexWrap = "wrap";
    else if (props.wrap === false) style.flexWrap = "nowrap";
    else if (props.wrap && typeof props.wrap === "object") {
      // Resp bool — base only for now.
      const base = (props.wrap as { base?: boolean }).base;
      if (base === true) style.flexWrap = "wrap";
    }
  }

  // --- Overlay -----------------------------------------------------------
  if (props.clip === true) {
    classes.add("fos-overlay-clip");
  }

  return {
    className: [...classes].join(" "),
    style,
    dataAttrs,
  };
}

function mapSpace(
  space: Record<string, unknown>,
  style: CssProperties,
  dataAttrs: Record<string, string>,
): void {
  const map: Array<[string, string, string]> = [
    ["p", "padding", "p"],
    ["px", "paddingInline", "px"],
    ["py", "paddingBlock", "py"],
    ["pt", "paddingBlockStart", "pt"],
    ["pb", "paddingBlockEnd", "pb"],
    ["pl", "paddingInlineStart", "pl"],
    ["pr", "paddingInlineEnd", "pr"],
  ];
  for (const [key, cssProp, stem] of map) {
    if (space[key] !== undefined) {
      applyRespProp(style, cssProp, stem, space[key], dataAttrs, `space.${key}`);
    }
  }
}

function mapSize(
  size: Record<string, unknown>,
  style: CssProperties,
  dataAttrs: Record<string, string>,
  ctx: StyleContext,
): void {
  if (size.w !== undefined) {
    if (size.w === "full" && ((ctx.flexChild && ctx.flexRow) || ctx.flexGrowFull)) {
      // On a ROW, full width means share the free space equally. On a column it
      // must not — `flex: 1 1 0` there sizes the main axis and zeroes the height.
      style.flex = "1 1 0";
      style.minWidth = "0";
    } else if (size.w === "full") {
      style.width = "100%";
    } else if (size.w === "auto") {
      style.width = "auto";
    } else {
      applyRespProp(style, "width", "w", size.w, dataAttrs, "size.w");
    }
  }
  if (size.h !== undefined) {
    if (size.h === "full" && ctx.flexChild && ctx.flexRow === false) {
      // The mirror of the width rule above. In a COLUMN, Figma's `h: fill`
      // means "take the remaining main-axis space" — that is `flex: 1 1 0`, not
      // `height: 100%`. Height-percent against an auto-height parent resolves
      // to `auto`, so the node collapses to its content and the design's
      // deliberate stretch silently disappears (it shortened the news card by
      // 34px). On a ROW, `h: fill` really is cross-axis, and 100% is correct.
      style.flex = "1 1 0";
      style.minHeight = "0";
    } else if (size.h === "full") style.height = "100%";
    else if (size.h === "auto") style.height = "auto";
    else applyRespProp(style, "height", "h", size.h, dataAttrs, "size.h");
  }
  if (size.minW !== undefined) applyRespProp(style, "minWidth", "min-w", size.minW, dataAttrs, "size.minW");
  if (size.maxW !== undefined) applyRespProp(style, "maxWidth", "max-w", size.maxW, dataAttrs, "size.maxW");
  if (size.minH !== undefined) applyRespProp(style, "minHeight", "min-h", size.minH, dataAttrs, "size.minH");
  if (size.maxH !== undefined) applyRespProp(style, "maxHeight", "max-h", size.maxH, dataAttrs, "size.maxH");
  if (typeof size.ratio === "string") {
    // "534/605" → aspect-ratio: 534 / 605
    const [a, b] = size.ratio.split("/");
    if (a && b) style.aspectRatio = `${a} / ${b}`;
    if (ctx.flexChild) {
      // Flex items shrink by default, and a shrunk item silently ignores its
      // aspect-ratio — the news card's 16:9 thumbnail collapsed from 213px to
      // ~140px the moment a sibling started growing. An explicitly declared
      // ratio is a statement about size, so it wins over flex's redistribution.
      style.flexShrink = "0";
    }
  }
}

function mapEnumResp(
  style: CssProperties,
  cssCamel: string,
  varStem: string,
  value: unknown,
  map: Record<string, string>,
  dataAttrs: Record<string, string>,
  propPath: string,
): void {
  if (typeof value === "string") {
    style[cssCamel] = map[value] ?? value;
    return;
  }
  if (value && typeof value === "object" && "base" in value) {
    const o = value as { base: string; md?: string; lg?: string };
    style[`--${varStem}-base`] = map[o.base] ?? o.base;
    if (o.md) style[`--${varStem}-md`] = map[o.md] ?? o.md;
    if (o.lg) style[`--${varStem}-lg`] = map[o.lg] ?? o.lg;
    style[cssCamel] = `var(--${varStem}-base)`;
  }
}

/** Convenience: resolve a colour tone to a CSS color value. */
export function resolveTone(tone: string | undefined): string | undefined {
  if (!tone) return undefined;
  if (tone.startsWith("color.")) return cssVar(tone);
  return tone;
}

/** Gradient token → var(). */
export function resolveGradient(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  if (ref.startsWith("gradient.")) return cssVar(ref);
  return ref;
}
