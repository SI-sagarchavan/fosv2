/**
 * Shared test setup.
 *
 * The registry is built from the real Southern Brave theme so token rules are
 * exercised against a real palette rather than a convenient stub. Everything
 * else in the suite is in-memory.
 */

import { readFileSync } from "node:fs";
import { createRegistry, loadSurfaces, loadTheme, type Registry } from "@fanos/tokens";
import type { FlatTree } from "../src/flat.js";

const THEME = new URL("../../tokens/fixtures/southern-brave.json", import.meta.url).pathname;
const SURFACES = new URL("../../tokens/surfaces/southern-brave.json", import.meta.url).pathname;
const CARD = new URL("../fixtures/player-card.json", import.meta.url);

let cached: Registry | undefined;

export function registry(): Registry {
  cached ??= createRegistry(loadTheme(THEME), { surfaces: loadSurfaces(SURFACES) });
  return cached;
}

/** A fresh deep copy every call, so a mutation in one test cannot leak into another. */
export function card(): FlatTree {
  return JSON.parse(readFileSync(CARD, "utf8")) as FlatTree;
}

export function nodeOf(tree: FlatTree, id: string) {
  const node = tree.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`test fixture has no node "${id}"`);
  return node;
}

/** A minimal valid tree to hang single-rule cases off. */
export function tinyTree(nodes: FlatTree["nodes"]): FlatTree {
  return { schemaVersion: "1.0.0", nodes };
}
