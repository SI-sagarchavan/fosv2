import type { Node } from "@fanos/dsl";
import { cssClassName, cssVar } from "@fanos/tokens";
import { interpolate, formatUnresolvedWarnings } from "../resolve/data.js";
import { resolveNode } from "../resolve/style.js";
import type { NodeRenderContext } from "../context.js";
import { styleToReact } from "./dom.js";

const AS_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "span"]);

const VERTICAL = new Set(["vertical-up", "vertical-down"]);

export function Text({ node, ctx }: { node: Node; ctx: NodeRenderContext }) {
  const props = node.props as Record<string, unknown>;
  // `align` on a Text is text-align, not flex cross-axis — see StyleContext.
  const resolved = resolveNode(props, { flexChild: ctx.flexChild, parentDirection: ctx.flexRow ? "row" : "column", alignIsTextAlign: true });

  const contentRaw = typeof props.content === "string" ? props.content : "";
  const { value, unresolved } = interpolate(contentRaw, ctx.data);
  if (unresolved.length) {
    for (const w of formatUnresolvedWarnings(node.id, "content", unresolved)) {
      console.warn(w);
    }
  }

  const styleToken = typeof props.style === "string" ? props.style : undefined;
  const typeClass =
    styleToken && styleToken.startsWith("type.")
      ? cssClassName("type", styleToken.slice("type.".length))
      : undefined;

  const tone = typeof props.tone === "string" ? props.tone : undefined;
  const orientation = typeof props.orientation === "string" ? props.orientation : undefined;

  // `truncate` is a MAX LINE COUNT, not a character budget — Figma clips by
  // line box, and the IR reports the count as `text.lines`.
  const truncate = typeof props.truncate === "number" && props.truncate > 0 ? props.truncate : undefined;

  const classes = [resolved.className, "fos-text", typeClass];
  if (truncate !== undefined) classes.push("fos-text-clamp");
  /**
   * A clamped text with a DECLARED height already has its box: Figma pinned it
   * (a fixed 30px for two 18px lines), and that box is what the layout around it
   * was drawn against. The clamp's margins exist to shrink an AUTO box down to
   * the ink height; applied to a fixed one they shrink it a second time, so the
   * card that hugs it came out 9.6px short and every sibling sat 4.8px low.
   */
  if (truncate !== undefined && hasFixedHeight(props.size)) classes.push("fos-text-fixed-h");
  if (props.trim === "none") classes.push("fos-text-untrimmed");
  if (props.wrap === false) classes.push("fos-text-nowrap");

  const style = { ...resolved.style };
  if (tone?.startsWith("color.")) style.color = cssVar(tone);

  // Presentation, never content: the tree keeps the authored characters.
  const TEXT_CASE: Record<string, string> = {
    upper: "uppercase",
    lower: "lowercase",
    title: "capitalize",
    none: "none",
  };
  const textCase = typeof props.textCase === "string" ? TEXT_CASE[props.textCase] : undefined;
  if (textCase) style.textTransform = textCase;

  // Capital W: React maps `WebkitLineClamp` to `-webkit-line-clamp`;
  // a lowercase key emits the invalid `webkit-line-clamp`.
  if (truncate !== undefined) style.WebkitLineClamp = String(truncate);

  const as = typeof props.as === "string" && AS_TAGS.has(props.as) ? props.as : "span";
  const Tag = as as "span";

  /**
   * Vertical text puts `writing-mode` on an INNER span, never on the positioned
   * element itself.
   *
   * `inset-inline-*` and `inset-block-*` resolve against the element's OWN
   * writing mode. Setting `vertical-rl` on the anchored element therefore swaps
   * its axes underneath `resolveAnchor`, and `mid-start` silently lands
   * top-centre instead of left-middle. Keeping the outer element in the
   * Overlay's writing mode makes the anchor mean what it says; the inner span
   * does the rotating.
   */
  const vertical = orientation !== undefined && VERTICAL.has(orientation);
  /**
   * Marks the OUTER element so the stylesheet can switch leading-trim off.
   * `.fos-text` trims to cap-height/baseline on its block axis; the outer
   * element is still horizontal, so that trim collapses its height to one cap
   * while the rotated inner span is far taller — the box stops describing what
   * is drawn, and every anchor computed from it lands wrong.
   */
  if (vertical) classes.push("fos-text-has-vertical");

  /**
   * `align` on vertical text means along the READING axis, as in Figma, where a
   * rotated layer's alignment turns with it. `text-align` on the horizontal outer
   * element cannot do that — it moves the rotated span across the box, not along
   * it — so the outer box becomes a column that places the span: `start` is where
   * reading begins (the bottom for vertical-up, the top for vertical-down). The
   * line box is centred across the box, matching Figma's cap-height-wide box.
   */
  if (vertical) {
    const align = typeof props.align === "string" ? props.align : "start";
    const up = orientation === "vertical-up";
    const along: Record<string, string> = up
      ? { start: "flex-end", center: "center", end: "flex-start" }
      : { start: "flex-start", center: "center", end: "flex-end" };
    style.display = "flex";
    style.flexDirection = "column";
    style.alignItems = "center";
    style.justifyContent = along[align] ?? along.start!;
  }

  return (
    <Tag
      className={classes.filter(Boolean).join(" ")}
      style={styleToReact(style)}
      data-fos-id={node.id}
      data-fos-type="Text"
      data-fos-type-style={styleToken}
      {...(orientation ? { "data-fos-orientation": orientation } : {})}
      {...resolved.dataAttrs}
    >
      {vertical ? (
        <span
          className={orientation === "vertical-up" ? "fos-text-vertical-up" : "fos-text-vertical-down"}
        >
          {value}
        </span>
      ) : (
        value
      )}
    </Tag>
  );
}

/** `size.h` is a length (raw px or a token), not `auto` or `full`. */
function hasFixedHeight(size: unknown): boolean {
  const h = (size as { h?: unknown } | undefined)?.h;
  if (h === undefined || h === null) return false;
  return h !== "auto" && h !== "full";
}
