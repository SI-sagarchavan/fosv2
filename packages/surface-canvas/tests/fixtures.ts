/**
 * Plain IR fixtures. No Figma, no plugin sandbox — just objects shaped like
 * what the extractor emits, so signature logic can be tested in isolation.
 */
import type { FrameIRNode } from "../src/ir/schema";

type NodeOverrides = Partial<Omit<FrameIRNode, "layout" | "geometry">> & {
  mode?: FrameIRNode["layout"]["mode"];
  sizing?: FrameIRNode["layout"]["sizing"];
  aspectBucket?: FrameIRNode["geometry"]["aspectBucket"];
  w?: number;
  h?: number;
};

let counter = 0;

/** Builds a complete, schema-shaped IR node with sane defaults. */
export function node(overrides: NodeOverrides = {}): FrameIRNode {
  const {
    mode = "none",
    sizing = { w: "fixed" as const, h: "fixed" as const },
    aspectBucket = "landscape",
    w = 320,
    h = 200,
    children = [],
    ...rest
  } = overrides;

  const zero = () => ({ value: 0, unbound: false });

  return {
    id: `n${++counter}`,
    name: "node",
    type: "FRAME",
    layout: {
      mode,
      gap: mode === "none" ? null : { value: 8, unbound: true },
      padding: { top: zero(), right: zero(), bottom: zero(), left: zero() },
      align: null,
      justify: null,
      wrap: false,
      sizing,
      positioning: "auto",
    },
    geometry: {
      bbox: { x: 0, y: 0, w, h },
      relBbox: { x: 0, y: 0, w, h },
      rotation: 0,
      aspect: h === 0 ? 0 : w / h,
      aspectBucket,
    },
    fill: null,
    stroke: null,
    radius: null,
    effects: [],
    opacity: 1,
    clipsContent: false,
    structuralSignature: "",
    canonicalSignature: "",
    repeatedSiblings: 1,
    depth: 0,
    childCount: children.length,
    children,
    ...rest,
  };
}

/**
 * A match card: image on top, two stacked text lines below.
 * `content` only touches things a signature must ignore — copy, colours,
 * names, ids, pixel dimensions.
 */
export function matchCard(content: {
  team: string;
  score: string;
  fill: string;
  width: number;
}): FrameIRNode {
  return node({
    name: `Match Card — ${content.team}`,
    type: "INSTANCE",
    componentKey: "match-card-key",
    mode: "vertical",
    sizing: { w: "fill", h: "hug" },
    aspectBucket: "portrait",
    w: content.width,
    h: content.width * 1.4,
    fill: { raw: content.fill, unbound: true },
    children: [
      node({
        type: "IMAGE",
        name: "Crest",
        aspectBucket: "square",
        image: { fit: "FILL", hasImageFill: true },
      }),
      node({
        type: "FRAME",
        name: "Copy",
        mode: "vertical",
        sizing: { w: "fill", h: "hug" },
        children: [
          textNode(content.team),
          textNode(content.score),
        ],
      }),
    ],
  });
}

export function textNode(characters: string): FrameIRNode {
  return node({
    type: "TEXT",
    name: characters,
    sizing: { w: "fill", h: "hug" },
    aspectBucket: "wide",
    text: {
      characters,
      unbound: true,
      fontSize: 14,
      fontFamily: "Inter",
      fontWeight: 600,
      lineHeight: 20,
      autoResize: "HEIGHT",
      lines: 1,
    },
  });
}

/**
 * A player card modelled on the real one: image, copy block, and a badge row
 * whose child count varies per instance (captain, wicketkeeper, neither).
 * That varying count is the only structural difference between instances —
 * exactly the case the canonical signature exists to collapse.
 */
export function playerCard(content: {
  name: string;
  badges: number;
  width: number;
}): FrameIRNode {
  return node({
    name: "organism_web_cricket_playercard",
    type: "INSTANCE",
    componentKey: "player-card-key",
    mode: "vertical",
    sizing: { w: "fixed", h: "fixed" },
    aspectBucket: "portrait",
    w: content.width,
    h: content.width * 1.47,
    children: [
      node({ type: "IMAGE", name: "Mask group", aspectBucket: "portrait" }),
      node({
        type: "FRAME",
        name: "PLAYER",
        mode: "vertical",
        sizing: { w: "hug", h: "hug" },
        children: [textNode(content.name), textNode("BATTER")],
      }),
      node({
        type: "FRAME",
        name: "Badges",
        mode: "vertical",
        sizing: { w: "fixed", h: "fixed" },
        aspectBucket: "portrait",
        children: Array.from({ length: content.badges }, (_, i) =>
          node({
            type: "INSTANCE",
            name: "atom_badges_master",
            mode: "horizontal",
            sizing: { w: "fill", h: "fixed" },
            aspectBucket: "square",
            children: [textNode(i === 0 ? "C" : "WK")],
          }),
        ),
      }),
    ],
  });
}

/**
 * A fixture card. The two kinds differ in the *kind* of their second child —
 * a finished match shows a score block, an upcoming one a countdown — so they
 * must stay apart under both signatures, even though the player cards above
 * collapse.
 */
export function fixtureCard(kind: "recent" | "upcoming"): FrameIRNode {
  const body =
    kind === "recent"
      ? node({
          name: "Scores",
          mode: "vertical",
          sizing: { w: "fill", h: "hug" },
          children: [textNode("166/5"), textNode("172/3")],
        })
      : node({
          name: "Countdown",
          mode: "horizontal",
          sizing: { w: "fill", h: "hug" },
          children: [textNode("02"), textNode("24"), textNode("12")],
        });

  return node({
    name: "D_2 Fixture Card",
    type: "INSTANCE",
    componentKey: `fixture-card-${kind}`,
    mode: "vertical",
    sizing: { w: "fixed", h: "fixed" },
    aspectBucket: "landscape",
    w: 380,
    h: 200,
    children: [textNode(kind === "recent" ? "RECENT" : "UPCOMING"), body],
  });
}

/** A left-nested chain n levels deep, for stack-safety checks. */
export function deepChain(depth: number): FrameIRNode {
  let current = node({ name: "leaf" });
  for (let i = 0; i < depth; i++) {
    current = node({ name: `level-${i}`, children: [current] });
  }
  return current;
}
