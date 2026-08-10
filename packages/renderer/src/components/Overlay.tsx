/**
 * Overlay / surface structure.
 *
 *   <div class="fos-overlay" style="position:relative; overflow:visible; aspect-ratio:…">
 *     <div class="fos-surface-layer" style="position:absolute; inset:0; overflow:hidden">
 *       <div class="fos-surface-card_player" style="width:100%; height:100%" aria-hidden />
 *     </div>
 *     <!-- children, position:absolute per anchor, z-index:1, DOM order -->
 *   </div>
 *
 * Token surface classes emit `position: relative` (for inset ::before borders).
 * That must NOT sit on the absolute fill layer or the layer collapses to zero
 * size and the card paints white. Outer layer owns the box model; inner node
 * owns token paint.
 *
 * When `clip: true`, the Overlay itself gets overflow:hidden.
 */

import type { ReactNode } from "react";
import type { Node } from "@fanos/dsl";
import { cssClassName } from "@fanos/tokens";
import { resolveNode } from "../resolve/style.js";
import type { NodeRenderContext } from "../context.js";
import { styleToReact } from "./dom.js";

export function Overlay({
  node,
  ctx,
  children,
}: {
  node: Node;
  ctx: NodeRenderContext;
  children?: ReactNode;
}) {
  const props = node.props as Record<string, unknown>;
  const resolved = resolveNode(props, { flexChild: ctx.flexChild });
  const clip = props.clip === true;

  const classes = ["fos-overlay", resolved.className];
  if (clip) classes.push("fos-overlay-clip");

  const surfaceRef = typeof props.surface === "string" ? props.surface : undefined;
  const surfaceLeaf =
    surfaceRef && surfaceRef.startsWith("surface.")
      ? surfaceRef.slice("surface.".length)
      : undefined;

  // Strip surface utility from the root — paint lives on the inner layer only.
  const rootClass = classes
    .join(" ")
    .split(/\s+/)
    .filter((c) => !c.startsWith("fos-surface-"))
    .join(" ");

  const rootStyle = { ...resolved.style };
  rootStyle.position = "relative";
  // Fill the Render width so aspect-ratio resolves to a real height.
  if (!rootStyle.width) rootStyle.width = "100%";
  if (clip) rootStyle.overflow = "hidden";
  else rootStyle.overflow = "visible";

  return (
    <div
      className={rootClass}
      style={styleToReact(rootStyle)}
      data-fos-id={node.id}
      data-fos-type="Overlay"
      data-fos-clip={clip ? "true" : "false"}
      {...resolved.dataAttrs}
    >
      {surfaceLeaf ? (
        <div className="fos-surface-layer" aria-hidden data-fos-surface-layer>
          <div
            className={cssClassName("surface", surfaceLeaf)}
            data-fos-surface={surfaceLeaf}
            style={{ width: "100%", height: "100%" }}
          />
        </div>
      ) : null}
      {children}
    </div>
  );
}
