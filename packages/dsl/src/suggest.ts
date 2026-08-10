/**
 * Suggestions for an unresolvable token ref.
 *
 * A T1 message that only says "does not resolve" makes the reader go and grep
 * the token file. Naming the three nearest real refs turns it into a fix.
 *
 * Pure. No I/O.
 */

import type { Registry } from "@fanos/tokens";
import type { Category } from "@fanos/tokens";
import { refCategory, unsignRef } from "./values.js";

function leafOf(ref: string): string {
  const bare = unsignRef(ref);
  const dot = bare.indexOf(".");
  return dot > 0 ? bare.slice(dot + 1) : bare;
}

function words(name: string): string[] {
  return name.split(/[._-]+/).filter(Boolean);
}

/** Length of the longest common subsequence. Short strings, so the O(nm) table is free. */
function lcsLength(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1).fill(0);
  const curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = 0;
    for (let j = 1; j <= b.length; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, curr[j - 1]!);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}

/**
 * Shared name segments dominate, character overlap breaks the tie.
 *
 * `card_playr` scores against `card_player` on the shared `card` segment, which
 * is the common real typo. A ref with nothing in common still ranks by character
 * overlap rather than returning nothing, because an arbitrary real ref is more
 * useful than silence.
 */
function score(query: string, candidate: string): number {
  const q = words(query);
  const c = new Set(words(candidate));
  const shared = q.filter((w) => c.has(w)).length;
  const overlap = lcsLength(query, candidate) / Math.max(query.length, candidate.length, 1);
  return shared * 2 + overlap;
}

/**
 * Up to `limit` refs from the same category, nearest first.
 *
 * Same category only: suggesting a colour for a broken surface ref would be
 * noise, and the category is the one thing the author definitely got right.
 */
export function suggestRefs(registry: Registry, ref: string, limit = 3): string[] {
  const category = refCategory(ref);
  if (!category) return [];

  const candidates = registry.list(category as Category);
  if (candidates.length === 0) return [];

  const leaf = leafOf(ref);
  return candidates
    .map((candidate) => ({ candidate, s: score(leaf, leafOf(candidate)) }))
    // `list()` is already deterministically sorted, so a stable sort keeps ties
    // in registry order.
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.candidate);
}
