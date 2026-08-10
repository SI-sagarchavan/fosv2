import type { Node } from "@fanos/dsl";
import { isRaw } from "@fanos/dsl";
import { cssVar } from "@fanos/tokens";
import { markRaw } from "../resolve/value.js";
import { resolveNode } from "../resolve/style.js";
import type { NodeRenderContext } from "../context.js";
import { styleToReact } from "./dom.js";
import { renderIcon } from "./icons.js";

export function Icon({ node, ctx }: { node: Node; ctx: NodeRenderContext }) {
  const props = node.props as Record<string, unknown>;
  const resolved = resolveNode(props, { flexChild: ctx.flexChild });

  const name = typeof props.name === "string" ? props.name : "unknown";
  let size = 16;
  if (isRaw(props.size) && typeof props.size.raw === "number") {
    size = props.size.raw;
    markRaw(resolved.dataAttrs, "size");
  } else if (typeof props.size === "number") {
    size = props.size;
  }

  const tone = typeof props.tone === "string" ? props.tone : undefined;
  const color = tone?.startsWith("color.") ? cssVar(tone) : tone;

  return (
    <span
      className={resolved.className}
      style={styleToReact({
        ...resolved.style,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: color ?? "",
        width: `${size}px`,
        height: `${size}px`,
      })}
      data-fos-id={node.id}
      data-fos-type="Icon"
      {...resolved.dataAttrs}
    >
      {renderIcon(name, { size, color })}
    </span>
  );
}
