import type { Node } from "@fanos/dsl";
import { cssRgbVarName, cssVar, cssVarName } from "@fanos/tokens";
import { resolveNode } from "../resolve/style.js";
import type { NodeRenderContext } from "../context.js";
import { styleToReact } from "./dom.js";

/**
 * tone + opacity compose to `background: rgb(var(--x-rgb) / var(--opacity))`.
 * Opacity tokens are emitted as 0–1 unit values.
 */
export function Divider({ node, ctx }: { node: Node; ctx: NodeRenderContext }) {
  const props = node.props as Record<string, unknown>;
  const resolved = resolveNode(props, { flexChild: ctx.flexChild });

  const orientation = props.orientation === "vertical" ? "vertical" : "horizontal";
  const tone = typeof props.tone === "string" ? props.tone : undefined;
  const opacity = typeof props.opacity === "string" ? props.opacity : undefined;

  const style = { ...resolved.style };
  if (tone?.startsWith("color.")) {
    if (opacity?.startsWith("opacity.")) {
      style.background = `rgb(var(${cssRgbVarName(tone)}) / var(${cssVarName(opacity)}))`;
    } else {
      style.background = cssVar(tone);
    }
  }

  return (
    <div
      className={`${resolved.className} fos-divider-${orientation}`}
      style={styleToReact(style)}
      data-fos-id={node.id}
      data-fos-type="Divider"
      role="separator"
      aria-orientation={orientation}
      {...resolved.dataAttrs}
    />
  );
}
