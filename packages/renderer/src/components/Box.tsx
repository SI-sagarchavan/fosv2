import type { ReactNode } from "react";
import type { Node } from "@fanos/dsl";
import { resolveNode } from "../resolve/style.js";
import type { NodeRenderContext } from "../context.js";
import { styleToReact } from "./dom.js";

export function Box({
  node,
  ctx,
  children,
}: {
  node: Node;
  ctx: NodeRenderContext;
  children?: ReactNode;
}) {
  const resolved = resolveNode(node.props as Record<string, unknown>, {
    flexChild: ctx.flexChild,
  });
  return (
    <div
      className={resolved.className}
      style={styleToReact(resolved.style)}
      data-fos-id={node.id}
      data-fos-type="Box"
      {...resolved.dataAttrs}
    >
      {children}
    </div>
  );
}
