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
  /**
   * DORMANT. No component forwards this, so both branches keyed on it below —
   * `size.w: "full"` on a row and `size.h: "full"` on a column — have never
   * executed. Measured before leaving it that way:
   *
   *   - wiring it naively regresses. `flex: 1 1 0` on a column child needs a
   *     definite parent height to distribute; inside a hugging column it
   *     resolves to nothing and the news grid's lead card collapses to 0px.
   *     `flex: 1 1 auto` is the basis that survives both cases.
   *   - wiring it with that correction is exactly NEUTRAL: 116 C2 errors across
   *     six fixtures before and after, and a hand-built row of a `full` child
   *     beside a hugging one lays out identically either way, because the hug
   *     child's min-content size already protects it.
   *
   * So it stays dormant deliberately: a behaviour change with no demonstrated
   * benefit is how a renderer acquires bugs nobody can bisect. Waking it needs
   * a case that proves it, not a tidy-up.
   */
  flexRow?: boolean;
  /**
   * Which way the parent Stack runs. Read ONLY by the no-shrink rule below.
   *
   * Deliberately not `flexRow`. That flag also gates the `size.w: "full"` and
   * `size.h: "full"` branches, and it turns out no component has ever forwarded
   * it — so those branches are dormant, and switching them on regresses this
   * very page: the lead card's inner stack takes `flex: 1 1 0` inside an
   * auto-height parent and collapses to 0px. Waking them is a real fix worth
   * making on its own, with its own evidence. It is not this fix.
   */
  parentDirection?: "row" | "column";
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
      /**
       * An explicit width on a ROW child is a statement, not a suggestion.
       *
       * Same bug as the ratio guard below, one prop over. Flex items shrink by
       * default, so a 182px thumbnail beside a `width: 100%` content column
       * gives up its space the moment the row is narrower than its contents
       * want — on the news grid it rendered 121.3px, 60.7px under the design,
       * and the content column pocketed every one of those pixels.
       *
       * Only on the MAIN axis. Cross-axis width in a column is not what flex
       * redistributes, and pinning shrink there would freeze a child that is
       * supposed to give way.
       */
      if (ctx.flexChild && ctx.parentDirection === "row") style.flexShrink = "0";
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
    } else if (size.h === "full" && ctx.flexChild && ctx.parentDirection === "row") {
      /**
       * On a ROW, `h: fill` is a CROSS-AXIS stretch — `align-self`, not a
       * percentage.
       *
       * `height: 100%` needs a definite parent height to resolve against. A row
       * that hugs its content has none, so the percentage goes indefinite and
       * silently becomes `auto`: the child sizes to its own content instead of
       * to the tallest sibling. On the news grid that is the whole lead-card
       * bug — the column rendered 363.8px against a 380px row, its inner stack
       * lost 16px it was supposed to have, and `clip: true` cut the overflow
       * off the top and bottom.
       *
       * `stretch` is also what survives `align-items: center` on the parent,
       * which is exactly the combination Figma produced here and CSS otherwise
       * resolves the other way.
       */
      style.alignSelf = "stretch";
    } else if (size.h === "full") style.height = "100%";
    else if (size.h === "auto") style.height = "auto";
    else {
      applyRespProp(style, "height", "h", size.h, dataAttrs, "size.h");
      // The mirror: in a COLUMN, height is the main axis, so an explicit one
      // is what flex would otherwise take back.
      if (ctx.flexChild && ctx.parentDirection === "column") style.flexShrink = "0";
    }
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
