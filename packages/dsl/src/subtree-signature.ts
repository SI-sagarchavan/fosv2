/**
 * Subtree signatures: "are these two DSL subtrees the same component?"
 *
 * Distinct from the IR's `canonicalSignature`, and deliberately not sharing a
 * line of code with it. That one groups FIGMA nodes from measurements a
 * designer's file happens to carry — sizing modes, aspect buckets — and it is
 * the right tool for a corpus of frames. This one groups the tree the compiler
 * produced, where the shape has already been resolved into props: a token ref,
 * a truncation limit, an anchor. Two hashes with two inputs and two jobs; a
 * shared implementation would drag one of them toward the other's vocabulary.
 *
 * WHAT IS HASHED is the whole design. A signature answers "same component,
 * different data" — so everything a CMS would swap is excluded and everything
 * a designer chose is kept. `truncate` is the sharp edge of that line and it
 * stays IN: the news grid's middle cards clamp 3 lines of headline and 3 of
 * summary while the trailing cards clamp 2 and 1, and those are two variants of
 * a card, not one card showing two articles. A signature that folded them
 * together would propose collapsing six cards into a Repeater and quietly lose
 * a line of copy on three of them.
 *
 * PURE. No filesystem, no process, no clock.
 */

import type { FlatNode, FlatTree } from "./flat.js";
import { sha1Hex } from "./sha1.js";

/**
 * Bumped whenever the descriptor changes.
 *
 * Signatures get stored — on a proposal, in a review, against a surface
 * version — and a descriptor change silently reusing the old prefix would let
 * two incomparable hashes sit in one column and compare unequal for the wrong
 * reason. A new prefix makes the old ones visibly old.
 */
export const SUBTREE_SIGNATURE_PREFIX = "d1";

/** How much of the digest a signature carries. */
const SIGNATURE_LENGTH = 10;

/**
 * Raw numerics collapse to this grid before hashing.
 *
 * Figma hands back 241.8481 where the designer dragged something to 242, and
 * two instances of one component routinely differ in the fourth decimal. Four
 * pixels is below the smallest space step and far under anything a person can
 * see, so it absorbs instance drift without ever merging a 116px thumbnail into
 * a 182px one.
 */
const RAW_BUCKET = 4;

/**
 * Prop names that carry CONTENT, at any depth.
 *
 * `href` is in here because a navigate action's target is the article, not the
 * card: three briefs linking to three different stories are three instances of
 * one component, and hashing the URL would split them every time.
 */
export const CONTENT_PROPS: ReadonlySet<string> = new Set(["content", "alt", "href", "label", "testId"]);

/**
 * Prop names that carry IDENTITY or annotation rather than shape.
 *
 * `_meta` holds `derivedFrom`, notes and conformance waivers — a record of how
 * a node came to be, which two instances of one component will disagree about
 * while being identical to look at.
 */
export const IDENTITY_PROPS: ReadonlySet<string> = new Set(["_meta"]);

/**
 * Per-type exclusions, applied only at the top level of that type's props.
 *
 * Scoped rather than global because the same name means different things on
 * different nodes: `Icon.name` is a glyph key and pure content, while a `name`
 * inside a Custom's opaque props is nothing this package can reason about.
 * `Custom.ref` is NOT excluded — the component and its version ARE the shape.
 */
export const TYPE_EXCLUSIONS: Readonly<Record<string, readonly string[]>> = {
  Image: ["src", "placeholder"],
  Icon: ["name"],
  Tabs: ["options"],
  Countdown: ["to"],
  Custom: ["props"],
};

/** The stable descriptor for one node, given its children's signatures. */
interface Descriptor {
  t: string;
  p: unknown;
  c: string[];
}

/**
 * The signature of the subtree rooted at `nodeId`.
 *
 * Signs the whole tree and reads one entry out of it — correct on its own, and
 * O(n) rather than O(n·depth) because the children are signed once. Use
 * {@link subtreeSignatures} when more than one node is wanted.
 */
export function subtreeSignature(tree: FlatTree, nodeId: string): string {
  const all = subtreeSignatures(tree);
  const sig = all.get(nodeId);
  if (sig === undefined) throw new Error(`no node with id "${nodeId}"`);
  return sig;
}

/**
 * Sign every node in one bottom-up pass.
 *
 * The order is post-order over an explicit stack rather than recursion: real
 * pages nest past the point where a recursive walk is comfortable, and a
 * signature that throws on a deep page is a signature nobody can rely on.
 */
export function subtreeSignatures(tree: FlatTree): Map<string, string> {
  const kids = new Map<string, FlatNode[]>();
  for (const node of tree.nodes) {
    if (node.parent === null) continue;
    const list = kids.get(node.parent);
    if (list) list.push(node);
    else kids.set(node.parent, [node]);
  }
  for (const list of kids.values()) list.sort((a, b) => a.idx - b.idx);

  const signatures = new Map<string, string>();

  /**
   * Roots, not root. A caller may hand this a detached fragment mid-repair, and
   * refusing to sign it would make the op that produced it untestable.
   */
  const ids = new Set(tree.nodes.map((n) => n.id));
  const roots = tree.nodes.filter((n) => n.parent === null || !ids.has(n.parent));

  const order: FlatNode[] = [];
  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.pop()!;
    order.push(node);
    const list = kids.get(node.id);
    if (list) for (let i = list.length - 1; i >= 0; i--) stack.push(list[i]!);
  }

  for (let i = order.length - 1; i >= 0; i--) {
    const node = order[i]!;
    const descriptor: Descriptor = {
      t: node.type,
      p: normaliseProps(node.type, node.props),
      c: (kids.get(node.id) ?? []).map((child) => signatures.get(child.id) ?? ""),
    };
    signatures.set(
      node.id,
      `${SUBTREE_SIGNATURE_PREFIX}:${sha1Hex(stableJson(descriptor)).slice(0, SIGNATURE_LENGTH)}`,
    );
  }

  return signatures;
}

/**
 * Props with content and identity taken out and raw numerics bucketed.
 *
 * Exported because the interesting failure mode of a signature is invisible —
 * two things hash apart and nobody can see why. Diffing two normalised prop
 * bags answers it immediately.
 */
export function normaliseProps(type: string, props: Record<string, unknown>): unknown {
  const excluded = new Set(TYPE_EXCLUSIONS[type] ?? []);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (excluded.has(key) || CONTENT_PROPS.has(key) || IDENTITY_PROPS.has(key)) continue;
    out[key] = normaliseValue(value);
  }
  return out;
}

function normaliseValue(value: unknown): unknown {
  if (isRaw(value)) return `raw~${bucket(value.raw)}`;
  if (Array.isArray(value)) return value.map(normaliseValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      // Content nests: `action: { kind: "navigate", href: "/news/1" }`.
      if (CONTENT_PROPS.has(key) || IDENTITY_PROPS.has(key)) continue;
      out[key] = normaliseValue(v);
    }
    return out;
  }
  return value;
}

/** `-0` and `0` must serialise the same; everything else is plain rounding. */
function bucket(n: number): number {
  const snapped = Math.round(n / RAW_BUCKET) * RAW_BUCKET;
  return snapped === 0 ? 0 : snapped;
}

function isRaw(value: unknown): value is { raw: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { _unbound?: unknown })._unbound === true &&
    typeof (value as { raw?: unknown }).raw === "number"
  );
}

/**
 * JSON with object keys in sorted order, so two prop bags that differ only in
 * insertion order hash the same. Arrays keep their order — an array's order is
 * meaningful everywhere it appears in this vocabulary.
 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
