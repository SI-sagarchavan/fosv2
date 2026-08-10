/**
 * Tree renderer — Server Components only. No "use client".
 *
 * Scope: Box, Stack, Overlay, Text, Image, Icon, Divider.
 * Other node types render a visible diagnostic placeholder.
 */

import type { FlatTree, Node } from "@fanos/dsl";
import { childrenOf, reify, rootOf } from "@fanos/dsl";
import type { NodeRenderContext, RenderConfig } from "../context.js";
import { Box } from "./Box.js";
import { Stack } from "./Stack.js";
import { Overlay } from "./Overlay.js";
import { Text } from "./Text.js";
import { Image } from "./Image.js";
import { Icon } from "./Icon.js";
import { Divider } from "./Divider.js";

export interface RenderProps {
  tree: FlatTree;
  data?: RenderConfig["data"];
  assets?: RenderConfig["assets"];
  themeSlug?: string;
  /** Optional root width in px (harness sets this). */
  width?: number;
  /**
   * The width the tree was DESIGNED at, from the Figma frame it came from.
   *
   * A fixed-aspect card is a media object, not a fluid layout: at twice the
   * size everything doubles, type included. Measured on the real pair — the
   * Figma frame is 281px wide with a 36px name (9.25% of width) and the shipped
   * web card is 534px with a ~68px name (8.80%) — the same object at 1.9x.
   *
   * Type tokens are absolute px per breakpoint and correctly do NOT scale with
   * a container, so honouring that at another size means scaling the whole
   * card. Set this and the renderer lays the tree out at its native size and
   * scales the result; leave it unset for a fluid component.
   */
  designWidth?: number;
}

export function Render({ tree, data, assets, themeSlug, width, designWidth }: RenderProps) {
  // Validate structure early — reify throws on broken trees.
  reify(tree);
  const root = rootOf(tree);
  if (!root) return null;

  const ctx: NodeRenderContext = { data, assets, themeSlug };
  const scale = width && designWidth && designWidth > 0 ? width / designWidth : 1;
  const scaled = scale !== 1;

  // Aspect comes from the root's own `size.ratio`, so the wrapper never has to
  // guess the design height.
  const ratio = (root.props as { size?: { ratio?: string } }).size?.ratio;
  const [rw, rh] = ratio ? ratio.split("/").map(Number) : [];
  const designHeight =
    designWidth && rw && rh && rw > 0 ? (designWidth * rh) / rw : undefined;

  const inner = <RenderNode node={root} tree={tree} ctx={ctx} />;

  return (
    <div
      className="fos-root"
      data-fos-theme={themeSlug}
      data-fos-root
      {...(scaled ? { "data-fos-scale": scale.toFixed(4) } : {})}
      style={{
        ...(width ? { width: `${width}px` } : {}),
        // Rounded: a 17-digit float in the DOM helps nobody and makes the
        // emitted markup non-deterministic to eyeball.
        ...(scaled && designHeight
          ? { height: `${Number((designHeight * scale).toFixed(4))}px`, overflow: "visible" }
          : {}),
      }}
    >
      {scaled ? (
        <div
          data-fos-scaler
          style={{
            width: `${designWidth}px`,
            ...(designHeight ? { height: `${designHeight}px` } : {}),
            transform: `scale(${scale})`,
            transformOrigin: "top left",
          }}
        >
          {inner}
        </div>
      ) : (
        inner
      )}
    </div>
  );
}

/** Resolve a dotted path to an array, for Repeater.over. */
function resolveList(path: string | undefined, data: unknown): unknown[] | undefined {
  if (!path) return undefined;
  let cur: unknown = data;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return Array.isArray(cur) ? cur : undefined;
}

function RenderNode({
  node,
  tree,
  ctx,
}: {
  node: Node;
  tree: FlatTree;
  ctx: NodeRenderContext;
}) {
  const kids = childrenOf(tree, node.id);
  const childCtxFor = (parentType: string): NodeRenderContext => {
    // A Resp direction carries its base in `base`; default is column.
    const dir = (node.props as { direction?: unknown }).direction;
    const base = typeof dir === "string" ? dir : (dir as { base?: string } | undefined)?.base;
    return {
      ...ctx,
      flexChild: parentType === "Stack",
      flexRow: parentType === "Stack" && base === "row",
      overlayChild: parentType === "Overlay",
    };
  };

  const renderChildren = (parentType: string) =>
    kids.map((child) => (
      <RenderNode key={child.id} node={child} tree={tree} ctx={childCtxFor(parentType)} />
    ));

  switch (node.type) {
    case "Box":
      return (
        <Box node={node} ctx={ctx}>
          {renderChildren("Box")}
        </Box>
      );
    case "Stack":
      return (
        <Stack node={node} ctx={ctx}>
          {renderChildren("Stack")}
        </Stack>
      );
    case "Overlay":
      return (
        <Overlay node={node} ctx={ctx}>
          {renderChildren("Overlay")}
        </Overlay>
      );
    case "Text":
      return <Text node={node} ctx={ctx} />;
    case "Image":
      return <Image node={node} ctx={ctx} />;
    case "Icon":
      return <Icon node={node} ctx={ctx} />;
    case "Divider":
      return <Divider node={node} ctx={ctx} />;
    case "Repeater": {
      const props = node.props as { over?: string; as?: string; limit?: number };
      const items = resolveList(props.over, ctx.data);
      if (items === undefined) {
        console.warn(`[fos-render] Repeater "${node.id}" — no list at "${props.over}"`);
        return null;
      }
      const capped = typeof props.limit === "number" ? items.slice(0, props.limit) : items;
      const alias = props.as ?? "item";
      return (
        <>
          {capped.map((item, i) => (
            // `display: contents` keeps each repetition out of the layout box
            // tree — a Repeater under a Stack must place its children directly
            // into that flex flow, not inside a wrapper. The attribute still
            // gives the repair loop something to map a diff region onto.
            <div key={`${node.id}-${i}`} style={{ display: "contents" }} data-fos-repeat={i} data-fos-repeat-of={node.id}>
              {kids.map((child) => (
                <RenderNode
                  key={child.id}
                  node={child}
                  tree={tree}
                  // A fragment passes its OWN context down: its children are flex
                  // items of the Repeater's parent, not of the Repeater.
                  ctx={{ ...ctx, data: { ...(ctx.data ?? {}), [alias]: item } }}
                />
              ))}
            </div>
          ))}
        </>
      );
    }
    default:
      console.warn(`[fos-render] node type "${node.type}" is out of scope for phase 1`);
      return (
        <div data-fos-id={node.id} data-fos-type={node.type} data-fos-unsupported>
          {renderChildren(node.type)}
        </div>
      );
  }
}
