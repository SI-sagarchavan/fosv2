/**
 * Uploaded background assets: the binding between an image the designer
 * exported from Figma and the UI element it should paint.
 *
 * The designer drops a file into the Assets tab. The bytes go into the Figma
 * document via `figma.createImage`, the hash and the target go into pluginData
 * on the export root, and both travel on the IR at export time — so the
 * compiler and the agent never have to guess which bitmap is decorative and
 * which is content.
 *
 * This replaced a feature that asked the designer to MARK Figma layers and had
 * the plugin flatten them itself. That was the wrong shape twice over: it made
 * them re-describe a composition Figma already understood, and it re-implemented
 * an exporter Figma already ships — one that honours export settings, scale and
 * effects, which ours did not. Exporting a region is something designers
 * already know how to do; the only open question afterwards is which region it
 * was, and that is a matching problem. See `ir/match-asset.ts`.
 *
 * PURE. No Figma. The sandbox reads and writes pluginData and owns the image
 * store; this file only decides what a valid list looks like and how it lands
 * on the IR.
 */
import {
  assetBindingSchema,
  isValidAssetName,
  type AssetBinding,
  type AssetFit,
  type FrameIRDocument,
  type FrameIRNode,
} from "./ir/schema.js";
import { compositePlacement, targetOptions, type AssetPlacement } from "./ir/placement.js";

export {
  ASSET_PLUGIN_KEY,
  assetRef,
  fitFromScaleMode,
  isValidAssetName,
} from "./ir/schema.js";
export type { AssetBinding, AssetFit, AssetMapping } from "./ir/schema.js";
export { assetPlacement, compositePlacement, targetOptions } from "./ir/placement.js";
export type { AssetPlacement, TargetOption } from "./ir/placement.js";
export {
  AUTO_APPLY_SCORE,
  isConfident,
  matchAssetToTargets,
  normalizeFileName,
} from "./ir/match-asset.js";
export type { TargetMatch, UploadedImage } from "./ir/match-asset.js";
export { MAX_ICON_PX, countPaths, hasText, isVectorOnly } from "./ir/artwork.js";

const NAME_RE = /[^a-z0-9]+/g;

/** Slug a filename or layer name into an asset key. Empty names become `background`. */
export function suggestAssetName(
  sourceName: string,
  taken: ReadonlySet<string> = new Set(),
): string {
  const base =
    sourceName
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/@[\d.]+x$/i, "")
      .toLowerCase()
      .replace(NAME_RE, "_")
      .replace(/^_+|_+$/g, "") || "background";
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const next = `${base}_${i}`;
    if (!taken.has(next)) return next;
  }
}

export function parseBindings(raw: string): AssetBinding[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      const result = assetBindingSchema.safeParse(item);
      return result.success ? [result.data] : [];
    });
  } catch {
    return [];
  }
}

export function serializeBindings(bindings: readonly AssetBinding[]): string {
  return bindings.length === 0 ? "" : JSON.stringify(bindings);
}

/**
 * An asset's identity: its image hash.
 *
 * The bytes ARE the asset. Not the name — that is editable — and not the
 * target, which can be re-pointed. Figma hashes image content, so dropping the
 * same file twice deduplicates for free instead of producing two copies of the
 * same pixels under two names.
 */
export function bindingKey(binding: AssetBinding): string {
  return binding.imageHash;
}

/**
 * Insert or replace an asset.
 *
 * Keyed on the image, so re-dropping a file already added re-points it rather
 * than adding a duplicate.
 */
export function upsertBinding(
  existing: readonly AssetBinding[],
  next: AssetBinding,
): AssetBinding[] {
  const without = existing.filter((b) => bindingKey(b) !== bindingKey(next));
  return [...without, next];
}

export function removeBinding(existing: readonly AssetBinding[], key: string): AssetBinding[] {
  return existing.filter((b) => bindingKey(b) !== key);
}

export function bindingByTarget(
  bindings: readonly AssetBinding[],
  targetId: string,
): AssetBinding | undefined {
  return bindings.find((b) => b.targetId === targetId);
}

export function bindingsForTarget(
  bindings: readonly AssetBinding[],
  targetId: string,
): AssetBinding[] {
  return bindings.filter((b) => b.targetId === targetId);
}

/**
 * Rename the asset.
 *
 * The name is not a label — it is half of `asset.texture.<name>`, which is the
 * key the compiler emits, the token registry resolves, and the run persists a
 * URL against. So a rename is validated rather than accepted: an unaddressable
 * name or a collision would produce a tree referencing a token nothing can
 * resolve, and that failure surfaces three services away from the designer who
 * caused it.
 */
export type RenameResult =
  | { ok: true; bindings: AssetBinding[] }
  | { ok: false; error: string };

export function renameBinding(
  existing: readonly AssetBinding[],
  key: string,
  name: string,
): RenameResult {
  const target = existing.find((b) => bindingKey(b) === key);
  if (!target) return { ok: false, error: "that asset is no longer in this frame" };
  if (target.name === name) return { ok: true, bindings: [...existing] };

  if (!isValidAssetName(name)) {
    return {
      ok: false,
      error: "lowercase letters, digits and underscores only — it becomes a token name",
    };
  }
  if (existing.some((b) => bindingKey(b) !== key && b.name === name)) {
    return { ok: false, error: `another asset in this frame is already called "${name}"` };
  }

  return {
    ok: true,
    bindings: existing.map((b) => (bindingKey(b) === key ? { ...b, name } : b)),
  };
}

export function setBindingFit(
  existing: readonly AssetBinding[],
  key: string,
  fit: AssetFit,
): AssetBinding[] {
  return existing.map((b) => (bindingKey(b) === key ? { ...b, fit } : b));
}

/**
 * Re-point an asset at a different element.
 *
 * Always records `manual`. An auto-mapping that the designer has corrected is
 * no longer an auto-mapping, and the distinction matters later: a wrong region
 * painted by a guess and a wrong region painted by a person are diagnosed
 * differently.
 */
export function retargetBinding(
  existing: readonly AssetBinding[],
  key: string,
  target: { id: string; name: string },
): AssetBinding[] {
  return existing.map((b) =>
    bindingKey(b) === key
      ? { ...b, targetId: target.id, targetName: target.name, mapping: "manual" as const }
      : b,
  );
}

/**
 * Where each asset lands inside the element it paints, keyed by image hash.
 *
 * An upload covers its target by construction — it was exported from that
 * region. The placement is still computed rather than assumed, because a
 * designer can re-point an asset at something a different shape, and should be
 * told when the result stops being full-bleed.
 */
export function placementsFromIr(
  root: FrameIRNode,
  bindings: readonly AssetBinding[],
): Record<string, AssetPlacement> {
  const byId = new Map<string, FrameIRNode>();
  walk(root, (node) => byId.set(node.id, node));

  const out: Record<string, AssetPlacement> = {};
  for (const binding of bindings) {
    const target = byId.get(binding.targetId);
    if (target) out[bindingKey(binding)] = compositePlacement([target], target);
  }
  return out;
}

/** The frames each asset could be re-pointed at, keyed by image hash. */
export function targetOptionsFromIr(
  root: FrameIRNode,
  bindings: readonly AssetBinding[],
): Record<string, ReturnType<typeof targetOptions>> {
  const out: Record<string, ReturnType<typeof targetOptions>> = {};
  for (const binding of bindings) {
    out[bindingKey(binding)] = targetOptions(root, binding.targetId);
  }
  return out;
}

/**
 * Stamp `doc.assets` and the per-node field the compiler walks.
 *
 * The list is the source of truth. The node stamp is a join so emit() does not
 * have to search. An asset whose target is not in this tree is dropped — a
 * binding to an element the designer later deleted must not travel.
 */
export function applyAssetBindings(
  doc: FrameIRDocument,
  bindings: readonly AssetBinding[],
): FrameIRDocument {
  const byId = new Map<string, FrameIRNode>();
  walk(doc.root, (node) => byId.set(node.id, node));

  const live = bindings.filter((b) => byId.has(b.targetId));
  /**
   * Keyed by target, so a second asset on the same node overwrites the first.
   *
   * Lossy and deliberately so: `node.background` is a convenience join for the
   * single-asset case, and `doc.assets` stays authoritative for the multi-asset
   * one the compiler actually reads — a plate under a pattern.
   */
  const targetOf = new Map(live.map((b) => [b.targetId, b]));

  return { ...doc, assets: live, root: stamp(doc.root, targetOf) };
}

function stamp(node: FrameIRNode, targetOf: ReadonlyMap<string, AssetBinding>): FrameIRNode {
  const asTarget = targetOf.get(node.id);
  const next: FrameIRNode = {
    ...node,
    children: node.children.map((child) => stamp(child, targetOf)),
  };

  if (asTarget) next.background = asTarget;
  else delete next.background;

  return next;
}

function walk(node: FrameIRNode, visit: (node: FrameIRNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}
