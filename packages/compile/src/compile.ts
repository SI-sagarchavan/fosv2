/**
 * IR -> DSL, deterministically.
 *
 * Same input, same output, every time. No model, no sampling, no ordering that
 * depends on a hash map's iteration. That is the whole value proposition: the
 * mechanical half of generation — coverage, geometry, tokens, sizing — is
 * exactly where a language model kept failing, and it is exactly the half a
 * compiler cannot get wrong.
 *
 * What it deliberately does NOT do:
 *
 *   - bindings. Every Text keeps its literal characters. Deciding that "19:30"
 *     is `{match.time}` while "DAYS" stays a label needs world knowledge the IR
 *     does not contain, and inventing a data model is API design.
 *   - Repeaters. Recognising four cards as one template is a semantic call.
 *   - icon names. The IR has no path data, so a glyph cannot be identified.
 *   - naming new surfaces. Reported instead, with the exact spec required.
 *
 * Those are the LLM's job. Everything else is arithmetic, and it happens here.
 */

import type { FlatNode, FlatTree } from "@fanos/dsl";
import { SCHEMA_VERSION } from "@fanos/dsl";
import {
  assetPlacement,
  assetRef,
  hasText,
  type AssetBinding,
  type AssetFit,
  type FrameIRDocument,
  type FrameIRNode,
} from "@fanos/surface-canvas/ir";
import type { NormalizedTheme, Surface, SurfaceSet } from "@fanos/tokens";
import {
  classify,
  flowChildren,
  iconNameSource,
  isDecorativeVector,
  isFillPlate,
  isIconGroup,
  paintsAsSurface,
  type DslType,
} from "./classify.js";
import { IdAllocator, isMeaningful, slug } from "./ids.js";
import { canonicalRef } from "./refs.js";
import { layoutBox } from "./geometry.js";
import { place, raw, size, space, stack, text, unhuggableAxes, type Raw } from "./props.js";
import { SurfaceResolver, specOf, type RequiredSurface } from "./surfaces.js";

export interface CompileOptions {
  theme: NormalizedTheme;
  surfaces?: SurfaceSet;
}

export interface CompileNote {
  /** Machine-readable reason, so callers can filter without parsing prose. */
  kind:
    | "unresolved-text-style"
    | "unresolved-paint"
    | "unknown-icon"
    | "new-surface"
    | "absorbed"
    | "background-asset"
    | "decorative-vector"
    | "pinned-size"
    | "unsupported-type";
  irId: string;
  nodeId?: string;
  message: string;
}

export interface RequiredAsset {
  name: string;
  ref: string;
  role: "background";
  sourceId: string;
  targetId: string;
}

export interface CompileResult {
  tree: FlatTree;
  /** Surfaces the tree references that the theme does not define yet. */
  requiredSurfaces: RequiredSurface[];
  /** Background files the tree references. The agent registers them as asset.texture.* */
  requiredAssets: RequiredAsset[];
  notes: CompileNote[];
  stats: { irNodes: number; emitted: number; absorbed: number };
}

interface Ctx {
  readonly theme: NormalizedTheme;
  readonly ids: IdAllocator;
  readonly surfaces: SurfaceResolver;
  readonly assetsByTarget: Map<string, AssetBinding[]>;
  /**
   * Every IR node by id.
   *
   * A binding's target need not be the source's parent — a designer can bind a
   * plate to the section two levels up — so deciding whether it covers its
   * target means reaching a node that is nowhere near the one being emitted.
   */
  readonly byId: Map<string, FrameIRNode>;
  readonly usedAssets: Map<string, AssetBinding>;
  readonly nodes: FlatNode[];
  readonly notes: CompileNote[];
  absorbed: number;
  irNodes: number;
}

export function compile(doc: FrameIRDocument, options: CompileOptions): CompileResult {
  const assetsByTarget = indexBindings(doc);
  const byId = new Map<string, FrameIRNode>();
  indexNodes(doc.root, byId);

  const ctx: Ctx = {
    theme: options.theme,
    ids: new IdAllocator(),
    surfaces: new SurfaceResolver(options.surfaces),
    assetsByTarget,
    byId,
    usedAssets: new Map(),
    nodes: [],
    notes: [],
    absorbed: 0,
    irNodes: 0,
  };

  emit(ctx, doc.root, null, 0, true, undefined);

  return {
    tree: { schemaVersion: SCHEMA_VERSION, nodes: ctx.nodes },
    requiredSurfaces: ctx.surfaces.missing(),
    requiredAssets: [...ctx.usedAssets.values()].map((b) => ({
      name: b.name,
      ref: assetRef(b.name),
      role: "background",
      sourceId: b.targetId,
      targetId: b.targetId,
    })),
    notes: ctx.notes,
    stats: { irNodes: ctx.irNodes, emitted: ctx.nodes.length, absorbed: ctx.absorbed },
  };
}

function indexBindings(doc: FrameIRDocument): Map<string, AssetBinding[]> {
  const byTarget = new Map<string, AssetBinding[]>();
  for (const binding of doc.assets ?? []) {
    const list = byTarget.get(binding.targetId) ?? [];
    list.push(binding);
    byTarget.set(binding.targetId, list);
  }
  return byTarget;
}

function indexNodes(n: FrameIRNode, into: Map<string, FrameIRNode>): void {
  into.set(n.id, n);
  for (const child of n.children ?? []) indexNodes(child, into);
}

function countIr(n: FrameIRNode): number {
  return 1 + (n.children ?? []).reduce((a, c) => a + countIr(c), 0);
}

/** The DSL `fit` for a mark, from the designer's choice with a safe default. */
function assetFitOf(binding: AssetBinding | undefined, node: FrameIRNode): AssetFit {
  if (binding?.fit) return binding.fit;
  // A 1.3.0 document carries no `fit`; the paint's own scaleMode is the next
  // best source, and `FIT` is the only one CSS reproduces exactly.
  return node.image?.fit === "FIT" ? "contain" : "cover";
}

/** `repeat` has no DSL Image equivalent — a tiled mark never reaches this path. */
function imageFitOf(fit: AssetFit): "cover" | "contain" | "none" {
  return fit === "contain" ? "contain" : fit === "none" ? "none" : "cover";
}

/**
 * The surface-layer fit for a mark.
 *
 * `SurfaceLayer` speaks cover / contain / repeat / auto. A mark reaching this
 * path either covers its target or is a tile, so `none` maps to `auto` — the
 * bitmap's natural size, which is what "no scaling" means to CSS.
 */
function surfaceFitOf(binding: AssetBinding): "cover" | "contain" | "repeat" | "auto" {
  switch (binding.fit) {
    case "contain":
      return "contain";
    case "repeat":
      return "repeat";
    case "none":
      return "auto";
    default:
      return "cover";
  }
}

/** "40,120 in a 1170×400 target" — the note has to be checkable by eye. */
function describePlacement(source: FrameIRNode, target: FrameIRNode): string {
  const p = assetPlacement(source, target);
  return (
    `${Math.round(p.offset.x)},${Math.round(p.offset.y)} ` +
    `in a ${Math.round(p.target.w)}×${Math.round(p.target.h)} "${target.name}"`
  );
}

/**
 * Emit one IR node and recurse.
 *
 * @param parentId  DSL parent id, or null for the root
 * @param idx       sibling index among EMITTED siblings, which is not the same
 *                  as the IR index once plates and icon paths are absorbed
 */
function emit(
  ctx: Ctx,
  node: FrameIRNode,
  parentId: string | null,
  idx: number,
  isRoot: boolean,
  parentType?: DslType,
): boolean {
  ctx.irNodes += 1;

  const iconGroup = !isRoot && isIconGroup(node);

  const type: DslType = iconGroup ? "Icon" : classify(node);
  const id = ctx.ids.take(node, type.toLowerCase());

  const props: Record<string, unknown> = {};

  // --- paint -------------------------------------------------------------
  // Read before children so a fill plate can be folded in below.
  applyPaint(ctx, node, props, id);

  // --- layout ------------------------------------------------------------
  if (type === "Stack") Object.assign(props, stack(ctx.theme, node.layout));
  if (type === "Overlay" && node.clipsContent) props.clip = true;
  if (type === "Stack" && node.clipsContent) props.clip = true;
  if (type === "Box" && node.clipsContent) props.clip = true;

  // A rule has no interior, so padding on it is meaningless — and ruinous: the
  // hairlines in the fixtures card declare 16px padding inside a 1px-tall box,
  // which Figma cannot honour and which CSS turns into a 33px bar. The IR's own
  // `bbox` says the node occupies 1px on screen; anything taller contradicts it.
  const sp = type === "Divider" ? undefined : space(ctx.theme, node.layout);
  if (sp) props.space = sp;

  const sz = size(node, isRoot);
  if (sz && Object.keys(sz).length > 0) props.size = sz;

  // Pinning a raw px costs responsiveness, so it is never done quietly.
  if (!isRoot) {
    const pinned = unhuggableAxes(node);
    const axes = [pinned.w ? "width" : null, pinned.h ? "height" : null].filter(Boolean);
    if (axes.length > 0) {
      ctx.notes.push({
        kind: "pinned-size",
        irId: node.id,
        nodeId: id,
        message:
          `${axes.join(" and ")} pinned to the IR box — every child is absolutely ` +
          `positioned, so there is nothing in flow for "hug" to size against`,
      });
    }
  }

  if (!isRoot && (node.layout.positioning === "absolute" || parentType === "Overlay")) {
    // A GROUP has no auto-layout, so Figma reports its children as `auto`
    // positioned even though nothing flows them — their box IS their position.
    // S8 requires an anchor on every Overlay child, and it is right to.
    props.place = place(node);
  }

  // --- leaves ------------------------------------------------------------
  switch (type) {
    case "Text": {
      const t = text(ctx.theme, node);
      if (!t) {
        ctx.notes.push({
          kind: "unresolved-text-style",
          irId: node.id,
          nodeId: id,
          message:
            `"${node.name}" has no resolvable text style` +
            (node.text?.styleRef ? ` (Figma: ${node.text.styleRef})` : " (unbound in Figma)") +
            ` — ${node.text?.fontSize ?? "?"}px/${node.text?.fontWeight ?? "?"} ` +
            `lh ${node.text?.lineHeight ?? "?"}. Bind it in Figma or add the token.`,
        });
        return false;
      }
      Object.assign(props, t);
      break;
    }
    case "Image": {
      /**
       * A content image. The IR has no CMS binding to offer, so the src is left
       * for the agent to fill and the renderer draws its placeholder.
       *
       * Uploaded assets never reach here: they are not layers in the design,
       * they are files bound to an element, and they paint that element's
       * surface. See `applyPaint`.
       */
      props.src = "";
      props.alt = node.name;
      props.fit = node.image?.fit === "FIT" ? "contain" : "cover";
      break;
    }
    case "Icon": {
      // No path data in the IR, so the glyph cannot be identified. The layer
      // name is the only hint, and the renderer draws a visible placeholder
      // plus a warning for anything unregistered.
      //
      // The name comes from the most specific layer in the wrapper chain, not
      // the outermost: every club crest on the fixtures page sits inside a
      // component instance called "Teams", and naming them after that made
      // sixteen different crests indistinguishable.
      const named = iconNameSource(node);
      props.name = isMeaningful(named.name) ? slug(named.name) : "unknown";
      const { w, h } = layoutBox(node);
      props.size = raw(Math.max(w, h));
      const tone = canonicalRef(ctx.theme, node.fill?.tokenRef ?? node.stroke?.tokenRef, "color");
      if (tone) props.tone = tone;
      ctx.notes.push({
        kind: "unknown-icon",
        irId: node.id,
        nodeId: id,
        message: `icon "${props.name}" from layer name — the IR carries no path data, so verify the glyph`,
      });
      break;
    }
    case "Divider": {
      /**
       * Orientation from `sizing` first, then the box.
       *
       * `sizing` leads because it is intent: a rule Figma stretches vertically
       * is vertical whatever its box says. The box is the fallback for a rule
       * that is fixed on both axes — and it is now the ROTATED box, so a
       * quarter-turned line no longer reads as its own opposite. Before
       * `geometry.rotation` existed this fallback saw the unrotated `w: 110,
       * h: 0`, called a vertical rule horizontal, and at `width: 100%` crushed
       * every sibling in the row.
       */
      const { w, h } = layoutBox(node);
      props.orientation =
        node.layout.sizing.h === "fill"
          ? "vertical"
          : node.layout.sizing.w === "fill"
            ? "horizontal"
            : w >= h
              ? "horizontal"
              : "vertical";
      const tone = canonicalRef(ctx.theme, node.stroke?.tokenRef ?? node.fill?.tokenRef, "color");
      if (tone) props.tone = tone;
      if (node.opacity < 1) {
        const pct = Math.round(node.opacity * 100);
        const ref = canonicalRef(ctx.theme, String(pct), "opacity");
        if (ref) props.opacity = ref;
      }
      // A rule's own box is its stroke, not a layout size.
      delete props.size;
      break;
    }
    case "Box": {
      /**
       * A vector too large to be a glyph. The Box keeps its box and its paint,
       * which is the honest limit of what the IR knows — there is no path data,
       * so a swoosh is emitted as the rectangle it occupies.
       *
       * Worth a note rather than silence, because it is fixable: marking the
       * layer on the Assets tab ships the real artwork as a bitmap. Before the
       * size guard existed these became Icons, and the renderer squared them —
       * one 1368x116 shape painted a 1368x1368 block over the page.
       */
      if (isDecorativeVector(node)) {
        const { w, h } = layoutBox(node);
        ctx.notes.push({
          kind: "decorative-vector",
          irId: node.id,
          nodeId: id,
          message:
            `"${node.name}" is ${Math.round(w)}×${Math.round(h)} of vector artwork — too large ` +
            `to be an icon, and the IR carries no path data. Emitted as a plain box with its ` +
            `paint. Mark it as a background asset in Surface Canvas to ship the real shape.`,
        });
      }
      break;
    }
    default:
      break;
  }

  ctx.nodes.push({ id, parent: parentId, idx, type, src: node.id, props } as FlatNode);

  // --- children ----------------------------------------------------------
  const leaf = type === "Text" || type === "Image" || type === "Icon" || type === "Divider";
  if (leaf) {
    // Everything below a leaf is how Figma drew it, not separate content.
    const below = countIr(node) - 1;
    ctx.irNodes += below;
    ctx.absorbed += below;
    return true;
  }

  // Does a photo already cover this element? Decided once, not per child.
  const painted = (ctx.assetsByTarget.get(node.id) ?? []).length > 0;

  let out = 0;
  for (const child of node.children ?? []) {
    /**
     * An element with a background photo has already had its decoration drawn.
     *
     * The designer exported that region from Figma, so the gradient plate, the
     * texture, the facet and the cutout are all IN the image. Emitting them
     * again paints them on top of the picture that already contains them —
     * which is what produced a header of dashed placeholders over a photo.
     *
     * Text is never absorbed, at any depth. Baking a headline into a bitmap
     * freezes copy the CMS is supposed to change, and no amount of visual
     * fidelity is worth that.
     */
    const absorbedBackground = painted && !hasText(child);

    if (isFillPlate(child, node) || absorbedBackground) {
      ctx.irNodes += countIr(child);
      ctx.absorbed += countIr(child);
      ctx.notes.push({
        kind: "absorbed",
        irId: child.id,
        nodeId: id,
        message: absorbedBackground
          ? `"${child.name}" is already in this element's background image — not emitted on top of it`
          : `"${child.name}" is a fill plate at the parent's exact size — folded into its surface`,
      });
      continue;
    }
    // Only a child that actually produced a node consumes an index; S1 requires
    // siblings to be contiguous from 0, and a skipped child would leave a hole.
    if (emit(ctx, child, id, out, false, type)) out += 1;
  }
  return true;
}

/** Fill / stroke / radius / shadow -> a `surface` prop, plus notes. */
function applyPaint(
  ctx: Ctx,
  node: FrameIRNode,
  props: Record<string, unknown>,
  id: string,
): void {
  // Text colour is `tone`, not a surface; Divider colour likewise.
  if (node.text !== undefined) return;
  // A childless image is a leaf — its file goes on `src`, not a surface.
  if (node.image !== undefined && (node.children ?? []).length === 0) return;

  // A frame whose fill lives on a child plate takes the plate's paint too.
  const plate = (node.children ?? []).find((c) => isFillPlate(c, node));
  const source = plate ?? node;
  let spec: Surface | undefined = specOf(ctx.theme, source);

  /**
   * Only the marks that actually paint this element's surface become layers.
   *
   * The rest are positioned pictures and are emitted as nodes instead. Filtering
   * with the SAME predicate the absorb decision uses is what keeps a mark from
   * being counted twice — painted here and emitted there — which is how a plate
   * ended up rendering both at its position and across the whole parent.
   */
  const backgrounds = ctx.assetsByTarget.get(node.id) ?? [];

  if (backgrounds.length > 0) {
    spec = {
      ...(spec ?? {}),
      layers: [
        ...(spec?.layers ?? []),
        ...backgrounds.map((background) => ({
          type: "image" as const,
          ref: assetRef(background.name),
          // The designer's choice, not a constant. `cover` for everything is
          // what rendered a repeating pattern as one stretched copy of itself.
          fit: surfaceFitOf(background),
        })),
      ],
    };
    for (const background of backgrounds) {
      ctx.usedAssets.set(background.name, background);
      ctx.notes.push({
        kind: "background-asset",
        irId: node.id,
        nodeId: id,
        message:
          `background "${background.name}" from "${background.fileName}" — ` +
          `${assetRef(background.name)}, painted as ${surfaceFitOf(background)}`,
      });
    }
  }
  if (!spec) {
    if (source.fill?.raw || source.stroke?.raw) {
      ctx.notes.push({
        kind: "unresolved-paint",
        irId: node.id,
        nodeId: id,
        message: `paint ${source.fill?.raw ?? source.stroke?.raw} is not bound to any token in Figma`,
      });
    }
    return;
  }
  const suggested = isMeaningful(node.name) ? slug(node.name) : `surface_${slug(id)}`;
  const ref = ctx.surfaces.resolve(spec, suggested, node.id);
  props.surface = ref;
}

export type { Raw };
