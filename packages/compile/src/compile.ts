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
import type { FrameIRDocument, FrameIRNode } from "@fanos/surface-canvas/ir";
import type { NormalizedTheme, SurfaceSet } from "@fanos/tokens";
import { classify, flowChildren, isFillPlate, isIconGroup, type DslType } from "./classify.js";
import { IdAllocator, isMeaningful, slug } from "./ids.js";
import { canonicalRef } from "./refs.js";
import { place, raw, size, space, stack, text, type Raw } from "./props.js";
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
    | "unsupported-type";
  irId: string;
  nodeId?: string;
  message: string;
}

export interface CompileResult {
  tree: FlatTree;
  /** Surfaces the tree references that the theme does not define yet. */
  requiredSurfaces: RequiredSurface[];
  notes: CompileNote[];
  stats: { irNodes: number; emitted: number; absorbed: number };
}

interface Ctx {
  readonly theme: NormalizedTheme;
  readonly ids: IdAllocator;
  readonly surfaces: SurfaceResolver;
  readonly nodes: FlatNode[];
  readonly notes: CompileNote[];
  absorbed: number;
  irNodes: number;
}

export function compile(doc: FrameIRDocument, options: CompileOptions): CompileResult {
  const ctx: Ctx = {
    theme: options.theme,
    ids: new IdAllocator(),
    surfaces: new SurfaceResolver(options.surfaces),
    nodes: [],
    notes: [],
    absorbed: 0,
    irNodes: 0,
  };

  emit(ctx, doc.root, null, 0, true, undefined);

  return {
    tree: { schemaVersion: SCHEMA_VERSION, nodes: ctx.nodes },
    requiredSurfaces: ctx.surfaces.missing(),
    notes: ctx.notes,
    stats: { irNodes: ctx.irNodes, emitted: ctx.nodes.length, absorbed: ctx.absorbed },
  };
}

function countIr(n: FrameIRNode): number {
  return 1 + (n.children ?? []).reduce((a, c) => a + countIr(c), 0);
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

  const sp = space(ctx.theme, node.layout);
  if (sp) props.space = sp;

  const sz = size(node, isRoot);
  if (sz && Object.keys(sz).length > 0) props.size = sz;

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
      props.src = "";
      props.alt = node.name;
      // Figma CROP means "show the crop rectangle the designer dragged". The
      // rectangle itself is not in the IR, so `cover` is the closest honest
      // approximation; FIT is an exact match for `contain`.
      props.fit = node.image?.fit === "FIT" ? "contain" : "cover";
      break;
    }
    case "Icon": {
      // No path data in the IR, so the glyph cannot be identified. The layer
      // name is the only hint, and the renderer draws a visible placeholder
      // plus a warning for anything unregistered.
      props.name = isMeaningful(node.name) ? slug(node.name) : "unknown";
      const { w, h } = node.geometry.relBbox;
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
       * Orientation from `sizing`, not from the box.
       *
       * A rule is a rotated line and the IR reports the UNROTATED box — the
       * newsletter's vertical divider arrives as `w: 110, h: 0`, which reads as
       * horizontal and, being `width: 100%`, then crushes every sibling in the
       * row. What survives rotation is which axis Figma set to `fill`: a rule
       * that stretches vertically is vertical, whatever its box says.
       */
      const { w, h } = node.geometry.relBbox;
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

  let out = 0;
  for (const child of node.children ?? []) {
    if (isFillPlate(child, node)) {
      ctx.irNodes += countIr(child);
      ctx.absorbed += countIr(child);
      ctx.notes.push({
        kind: "absorbed",
        irId: child.id,
        nodeId: id,
        message: `"${child.name}" is a fill plate at the parent's exact size — folded into its surface`,
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

  // A frame whose fill lives on a child plate takes the plate's paint too.
  const plate = (node.children ?? []).find((c) => isFillPlate(c, node));
  const source = plate ?? node;
  const spec = specOf(ctx.theme, source);
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
