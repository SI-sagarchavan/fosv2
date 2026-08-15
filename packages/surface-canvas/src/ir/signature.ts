/**
 * Structural signatures and repeated-sibling detection.
 *
 * Pure. No Figma API, no zod, no imports at all — everything here runs against
 * plain objects so it can be unit tested and reused outside the plugin sandbox.
 *
 * Two signatures are emitted per node, because grouping has two jobs and no
 * single hash does both:
 *
 *   structuralSignature — strict. "Is this the identical shape?" Keeps
 *     childCount and folds three levels deep, so an optional badge or an extra
 *     nav chevron makes a different signature. Right for exact-shape work.
 *
 *   canonicalSignature  — component family. "Is this the same kind of thing?"
 *     Drops childCount and folds one level, so instances of one component that
 *     differ only by an optional child collapse together. Right for run
 *     detection and component inventory.
 *
 * Both encode SHAPE ONLY. Two instances of the same card component with
 * completely different copy, colours, ids and pixel dimensions must produce
 * identical signatures; that is the whole point.
 */

/** How many levels of descendants fold into a node's strict signature. */
export const SIGNATURE_DEPTH_LIMIT = 3;

/**
 * Depth for the canonical signature.
 *
 * One level, not three. Grid-searched against real pages: at depth 3 no
 * descriptor collapses five instances of one player-card component while still
 * splitting two genuinely different fixture cards, because depth 3 pulls the
 * optional badge subtree into the hash. Depth 1 satisfies both.
 */
export const CANONICAL_DEPTH_LIMIT = 1;

/** Bumped whenever a descriptor format changes, so old corpora are detectable. */
const SIGNATURE_PREFIX = "s2";
const CANONICAL_PREFIX = "c1";

/**
 * Stand-in bucket for nodes that size to their own content.
 *
 * A hug-sized node's aspect ratio is a measurement of what is inside it: the
 * text "116.67" hugs wider than "300", so the identical node in two instances
 * of one component buckets as `ultrawide` in one and `landscape` in the other.
 * That is content, so it cannot enter a signature. Observed in the wild on
 * player cards, where it split five instances of one component five ways.
 */
const CONTENT_SIZED_BUCKET = "hug";

/** The minimum shape a node must have to be signable. */
export interface StructuralNode {
  type: string;
  layout: { mode: string; sizing: { w: string; h: string } };
  geometry: { aspectBucket: string };
  children: readonly StructuralNode[];
}

/** A node that signatures get written back onto. */
export interface AnnotatableNode extends StructuralNode {
  structuralSignature: string;
  canonicalSignature: string;
  repeatedSiblings: number;
  childCount: number;
  children: AnnotatableNode[];
}

/**
 * 64-bit FNV-1a, run as two independent 32-bit lanes and concatenated.
 * Cheap, dependency-free, and collision-safe enough for corpus grouping.
 */
export function hashString(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c + i;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return (
    (h1 >>> 0).toString(16).padStart(8, "0") +
    (h2 >>> 0).toString(16).padStart(8, "0")
  );
}

function aspectFor(node: StructuralNode): string {
  const { w, h } = node.layout.sizing;
  return w === "hug" || h === "hug" ? CONTENT_SIZED_BUCKET : node.geometry.aspectBucket;
}

/**
 * The strict shape descriptor for a single node, excluding its subtree.
 * Deliberately excludes: id, name, text characters, colours, exact dimensions.
 */
export function describeShape(node: StructuralNode): string {
  const { type, layout } = node;
  const { w, h } = layout.sizing;
  return `${type}:${layout.mode}:${w}${h}:${node.children.length}:${aspectFor(node)}`;
}

/**
 * The canonical descriptor: the strict one minus `childCount`.
 *
 * Dropping the count is what lets one component's instances collapse. On a
 * real page the badge row inside a player card holds 0, 1 or 2 badges across
 * five instances of the same component — identical in kind, different in
 * count. Everything else about the shape is retained.
 */
export function describeCanonicalShape(node: StructuralNode): string {
  const { type, layout } = node;
  const { w, h } = layout.sizing;
  return `${type}:${layout.mode}:${w}${h}:${aspectFor(node)}`;
}

/**
 * Strict signature for one node, folding in up to `depthLimit` levels.
 * Recomputes the subtree on every call — fine for tests and spot checks; use
 * `annotateTree` when signing a whole document.
 *
 * Recursion here is bounded by `depthLimit`, not by tree height.
 */
export function computeStructuralSignature(
  node: StructuralNode,
  depthLimit: number = SIGNATURE_DEPTH_LIMIT,
): string {
  return `${SIGNATURE_PREFIX}:${levelHash(node, depthLimit, describeShape)}`;
}

/** Canonical signature for one node. Same contract, looser descriptor. */
export function computeCanonicalSignature(
  node: StructuralNode,
  depthLimit: number = CANONICAL_DEPTH_LIMIT,
): string {
  return `${CANONICAL_PREFIX}:${levelHash(node, depthLimit, describeCanonicalShape)}`;
}

/**
 * Hash of a node folding in exactly `depthLimit` levels below it.
 * `annotateTree` reproduces this bit for bit via memoized levels.
 */
function levelHash(
  node: StructuralNode,
  depthLimit: number,
  describe: (n: StructuralNode) => string,
): string {
  const own = describe(node);
  if (depthLimit <= 0 || node.children.length === 0) return hashString(own);
  const parts = node.children
    .map((child) => levelHash(child, depthLimit - 1, describe))
    .join(",");
  return hashString(`${own}(${parts})`);
}

/**
 * Count consecutive runs of siblings sharing a key and write the run length
 * onto every member. A node with no matching neighbour gets 1.
 *
 * Five identical match cards in a row → every one of them reports 5.
 * Runs are strictly consecutive: card, card, banner, card, card → 2, 2, 1, 2, 2.
 */
export function assignRepeatedSiblings<T extends { repeatedSiblings: number }>(
  siblings: T[],
  keyOf: (node: T) => string,
): void {
  let runStart = 0;
  for (let i = 1; i <= siblings.length; i++) {
    const prev = siblings[runStart];
    const current = i < siblings.length ? siblings[i] : undefined;
    if (current && prev && keyOf(current) === keyOf(prev)) continue;
    const runLength = i - runStart;
    for (let j = runStart; j < i; j++) {
      const member = siblings[j];
      if (member) member.repeatedSiblings = runLength;
    }
    runStart = i;
  }
}

/**
 * Sign and count an entire tree in one bottom-up pass.
 *
 * Signatures at every depth limit 0..N are memoized per node, so a node's
 * limit-3 signature is built from its children's limit-2 signatures rather
 * than by re-walking the subtree. Cost is O(nodes × depthLimit).
 *
 * Also fills in `childCount`, which is derived, not read from Figma.
 *
 * Runs use the canonical signature: a row of one component's instances is a
 * repeated run even when an optional badge makes their strict shapes differ.
 */
export function annotateTree<T extends AnnotatableNode>(
  root: T,
  depthLimit: number = SIGNATURE_DEPTH_LIMIT,
  canonicalDepthLimit: number = CANONICAL_DEPTH_LIMIT,
): T {
  const strictLevels = new Map<AnnotatableNode, string[]>();
  const canonLevels = new Map<AnnotatableNode, string[]>();
  const order: AnnotatableNode[] = [];

  // Iterative pre-order collect, so we can walk it backwards for post-order.
  // Explicit stack — client files nest deep enough to blow the call stack.
  const stack: AnnotatableNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as AnnotatableNode;
    order.push(node);
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = node.children[i];
      if (child) stack.push(child);
    }
  }

  for (let i = order.length - 1; i >= 0; i--) {
    const node = order[i];
    if (!node) continue;
    const kids = node.children;
    node.childCount = kids.length;

    node.structuralSignature = `${SIGNATURE_PREFIX}:${memoize(
      node,
      kids,
      depthLimit,
      describeShape,
      strictLevels,
    )}`;
    node.canonicalSignature = `${CANONICAL_PREFIX}:${memoize(
      node,
      kids,
      canonicalDepthLimit,
      describeCanonicalShape,
      canonLevels,
    )}`;
  }

  // Signatures exist for every node now; count runs top-down.
  root.repeatedSiblings = 1;
  for (const node of order) {
    if (node.children.length > 0) {
      assignRepeatedSiblings(node.children, (n) => n.canonicalSignature);
    }
  }

  return root;
}

/** Fills `levels[node] = [depth0, depth1, … depthLimit]` and returns the last. */
function memoize(
  node: AnnotatableNode,
  kids: AnnotatableNode[],
  depthLimit: number,
  describe: (n: StructuralNode) => string,
  levels: Map<AnnotatableNode, string[]>,
): string {
  const own = describe(node);
  const own0 = hashString(own);
  const nodeLevels: string[] = [own0];
  for (let k = 1; k <= depthLimit; k++) {
    if (kids.length === 0) {
      nodeLevels.push(own0);
      continue;
    }
    const parts = kids.map((child) => levels.get(child)?.[k - 1] ?? "").join(",");
    nodeLevels.push(hashString(`${own}(${parts})`));
  }
  levels.set(node, nodeLevels);
  return nodeLevels[depthLimit] as string;
}
