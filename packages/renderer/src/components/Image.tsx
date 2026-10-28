/**
 * Image leaf.
 *
 * - plain <img> for runtime bindings and remote URLs (CDN cutouts)
 * - scrim as ::after with gradient token (above image, below later siblings)
 * - placeholder when resolved src is empty
 */

import { absolutize, fillImageRatio, type Node } from "@fanos/dsl";
import { cssVar, resolveAsset, type AssetContext } from "@fanos/tokens";
import { interpolate, formatUnresolvedWarnings } from "../resolve/data.js";
import { resolveNode } from "../resolve/style.js";
import type { NodeRenderContext } from "../context.js";
import { styleToReact } from "./dom.js";

const FIT_MAP: Record<string, string> = {
  cover: "cover",
  contain: "contain",
  fill: "fill",
  none: "none",
};

export function Image({ node, ctx }: { node: Node; ctx: NodeRenderContext }) {
  const props = node.props as Record<string, unknown>;
  const resolved = resolveNode(props, { flexChild: ctx.flexChild, parentDirection: ctx.flexRow ? "row" : "column" });

  const srcTemplate = typeof props.src === "string" ? props.src : "";
  const altTemplate = typeof props.alt === "string" ? props.alt : "";
  const srcResult = interpolate(srcTemplate, ctx.data, { timeZone: ctx.timeZone });
  const altResult = interpolate(altTemplate, ctx.data, { timeZone: ctx.timeZone });
  for (const w of formatUnresolvedWarnings(node.id, "src", srcResult.unresolved)) console.warn(w);
  for (const w of formatUnresolvedWarnings(node.id, "alt", altResult.unresolved)) console.warn(w);

  /**
   * A CAST thumbnail is `/static-assets/media/{{RATIO}}-<file>`: the CDN cuts
   * the crop named in the URL, and the crop is a DESIGN fact — this Image's
   * `ratio` — not a data one. Same rule as fanxp's Img atom (`16/9` → `16-9`,
   * none → `0`, the CDN's 16:9 default). Then the URL is made absolute against
   * the tenant, since `/static-assets` means nothing on localhost.
   */
  const ratio = typeof props.ratio === "string" ? props.ratio : undefined;
  let src = absolutize(fillImageRatio(srcResult.value, ratio), ctx.origin);
  if (src.startsWith("asset.") && ctx.assets) {
    try {
      src = resolveAsset(src, ctx.assets);
    } catch {
      src = "";
    }
  }

  const placeholder = typeof props.placeholder === "string" ? props.placeholder : undefined;
  let placeholderUrl: string | undefined;
  if (placeholder?.startsWith("asset.") && ctx.assets) {
    try {
      placeholderUrl = resolveAsset(placeholder, ctx.assets);
    } catch {
      placeholderUrl = undefined;
    }
  }

  const showPlaceholder = !src;
  const displaySrc = showPlaceholder ? placeholderUrl ?? "" : src;

  const fit = typeof props.fit === "string" ? FIT_MAP[props.fit] ?? props.fit : "cover";
  const scrim = typeof props.scrim === "string" ? props.scrim : undefined;
  const place = props.place as { anchor?: string } | undefined;
  const anchored = Boolean(place?.anchor);

  const style = { ...resolved.style };
  if (scrim?.startsWith("gradient.")) {
    style["--fos-image-scrim"] = cssVar(scrim);
  }

  // Anchored cutouts with only height need a width so object-fit has a box.
  if (anchored && !style.width && !style["--w-base"]) {
    style.width = "100%";
  }

  const imgStyle: Record<string, string> = {
    objectFit: fit,
  };
  if (typeof props.position === "string") {
    imgStyle.objectPosition = props.position.replace(/-/g, " ");
  }
  /**
   * A `fill` image's box IS its parent's, so its ratio only names the CDN crop
   * (see `fillImageRatio` above). As an aspect-ratio it fought the box: with the
   * 100% width set above, the browser took the height from the ratio, and a 4:3
   * hero inside a taller phone card covered only its top half.
   */
  if (typeof props.ratio === "string" && place?.anchor !== "fill") {
    const [a, b] = props.ratio.split("/");
    if (a && b) style.aspectRatio = `${a} / ${b}`;
  }

  const wasBinding = srcTemplate.includes("{");

  return (
    <div
      className={`${resolved.className} fos-image`}
      style={styleToReact(style)}
      data-fos-id={node.id}
      data-fos-type="Image"
      data-fos-anchored={anchored ? "true" : undefined}
      data-scrim={scrim ? "true" : undefined}
      data-fos-placeholder={showPlaceholder ? "true" : undefined}
      {...resolved.dataAttrs}
    >
      {displaySrc ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={displaySrc}
          alt={altResult.value}
          style={imgStyle}
          data-fos-binding={wasBinding ? "true" : undefined}
        />
      ) : (
        <span data-fos-missing-image style={{ display: "block", width: "100%", height: "100%" }} />
      )}
    </div>
  );
}

export function resolveImageAsset(ref: string, assets: AssetContext): string {
  return resolveAsset(ref, assets);
}
