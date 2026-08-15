/**
 * A synthetic page with the same SHAPE as the real Southern Brave file.
 *
 * This is not the real file — that lives in Figma and cannot be committed. It is
 * a Frame IR document built to the distribution the build spec recorded from it:
 *
 *   1,596 nodes, 2,485 bindable slots, 1,339 bound / 1,146 loose  (53.9%)
 *   79 groups holding 516 distinct layers
 *   root layout.mode "none", top-level widths 1366 and 1368 only
 *   the seven named loose-value clusters, at their recorded counts
 *   the eight recorded subpixel values
 *
 * What the acceptance test proves, then, is that the engine turns that
 * distribution into the documented report — the score, the blockers with their
 * counts, the seven batches in the right order, and the right safety verdicts.
 * What it cannot prove is that the real file has this distribution. Running the
 * plugin against the file is the only thing that establishes that, and the README
 * says so plainly.
 *
 * Every number below is a named constant so a failure reads as "the engine
 * disagrees" rather than "some number moved".
 */
import type { FrameIRDocument, FrameIRNode, IRNodeType, TokenValue } from "../src/ir/schema.js";
import {
  boundEffect,
  boundFill,
  boundStroke,
  boundText,
  bound,
  document,
  gradient,
  loose,
  looseEffect,
  looseFill,
  looseStroke,
  looseText,
  node,
  resetIds,
  withDepths,
} from "./health-fixtures.js";

export const SHAPE = {
  nodeCount: 1596,
  totalSlots: 2485,
  boundSlots: 1339,
  looseSlots: 1146,
  coveragePercent: 53.9,
  groups: 79,
  groupedLayers: 516,
  topLevelWidths: [1366, 1368],
  /** The four exact batches: 110 + 78 + 73 + 60. */
  safeSlots: 321,
  oneClickPercent: 12.9,
  subpixelValues: [10.4, 12.678, 13.209, 13.481, 13.487, 14.83, 20.23, 21.818],
} as const;

/** The seven clusters the spec expects at the top of the queue, in order. */
export const CLUSTERS = [
  { kind: "fill", value: "linear-gradient", count: 243, distinctGradients: 4 },
  { kind: "fill", value: "#ffffff", count: 110, token: "color.core_neu_00", safe: true },
  { kind: "gap", value: "10", count: 78, token: "space.2_5", safe: true },
  { kind: "radius", value: "0", count: 73, token: "radius.none", safe: true },
  { kind: "padding", value: "16", count: 60, token: "space.4", safe: true },
  { kind: "fill", value: "#ff4b32", count: 36, nearCandidates: 2 },
  { kind: "fill", value: "#000000", count: 35, nearCandidates: 2 },
] as const;

const GRADIENTS = [
  gradient("#ff4b32ff", "#2939a3ff"),
  gradient("#000000cc", "#00000000"),
  gradient("#ffffffff", "#f5f5f5ff"),
  gradient("#e10a15ff", "#310204ff"),
];

/**
 * The long tail of loose values, so the remaining ~360 loose slots form
 * realistic small batches instead of one enormous one. Two properties matter:
 *
 *   capped at FILLER_CAP each, so every tail batch stays below the smallest
 *   named cluster (35) and therefore out of the top seven
 *
 *   NONE of them is an exact token match. That is not fixture convenience — it
 *   is what the recorded numbers imply. The build spec says the four exact
 *   batches total +12.9% one click away, and 321/2485 IS 12.9%, so on the real
 *   file the tail contributes no further exact matches. Every value here is
 *   deliberately one or two off the scale: near matches a designer has to
 *   review, never a safe bulk bind.
 */
const FILLER_CAP = 20;

const FILLER: Array<{ kind: SlotKindLocal; value: string }> = [
  { kind: "fill", value: "#f4f4f4" },
  { kind: "fill", value: "#2a3aa4" },
  { kind: "fill", value: "#e20b16" },
  { kind: "fill", value: "#1b1b1b" },
  { kind: "fill", value: "#767676" },
  { kind: "fill", value: "IMAGE:FILL" },
  { kind: "fill", value: "#fbfbfb" },
  { kind: "fill", value: "#222222" },
  { kind: "stroke", value: "#e1e1e1" },
  { kind: "stroke", value: "#bebebe" },
  { kind: "stroke", value: "#fefefe" },
  { kind: "gap", value: "7" },
  { kind: "gap", value: "13" },
  { kind: "gap", value: "27" },
  { kind: "gap", value: "33" },
  { kind: "padding", value: "11" },
  { kind: "padding", value: "21" },
  { kind: "padding", value: "31" },
  { kind: "radius", value: "7" },
  { kind: "radius", value: "13" },
  { kind: "radius", value: "27" },
  { kind: "effect", value: "DROP_SHADOW" },
  { kind: "effect", value: "INNER_SHADOW" },
  { kind: "text", value: "13/18 500 Montserrat" },
  { kind: "text", value: "11/16 400 Montserrat" },
  { kind: "text", value: "15/22 600 Inter" },
  { kind: "text", value: "9/12 400 Montserrat" },
  { kind: "text", value: "17/26 700 Inter" },
  { kind: "text", value: "19/28 300 Montserrat" },
];

type SlotKindLocal = "fill" | "stroke" | "gap" | "padding" | "radius" | "text" | "effect";

interface SlotRequest {
  kind: SlotKindLocal;
  bound: boolean;
  raw?: string;
  value?: number;
  text?: ReturnType<typeof looseText>;
}

// ---------------------------------------------------------------------------
// Slot requests
// ---------------------------------------------------------------------------

function looseRequests(): SlotRequest[] {
  const out: SlotRequest[] = [];

  for (let i = 0; i < 243; i++) {
    out.push({ kind: "fill", bound: false, raw: GRADIENTS[i % GRADIENTS.length]! });
  }
  for (let i = 0; i < 110; i++) out.push({ kind: "fill", bound: false, raw: "#ffffff" });
  for (let i = 0; i < 78; i++) out.push({ kind: "gap", bound: false, value: 10 });
  for (let i = 0; i < 73; i++) out.push({ kind: "radius", bound: false, value: 0 });
  for (let i = 0; i < 60; i++) out.push({ kind: "padding", bound: false, value: 16 });
  for (let i = 0; i < 36; i++) out.push({ kind: "fill", bound: false, raw: "#ff4b32" });
  for (let i = 0; i < 35; i++) out.push({ kind: "fill", bound: false, raw: "#000000" });

  // The recorded subpixel values, three occurrences each, rotating through the
  // three numeric slot kinds so F7 is exercised on all of them.
  const numericKinds: SlotKindLocal[] = ["padding", "gap", "radius"];
  SHAPE.subpixelValues.forEach((value, index) => {
    for (let i = 0; i < 3; i++) {
      out.push({ kind: numericKinds[(index + i) % 3]!, bound: false, value });
    }
  });

  // Filler, round-robin so no single value exceeds FILLER_CAP.
  let cursor = 0;
  const used = new Map<string, number>();
  const guard = FILLER.length * FILLER_CAP + FILLER.length;
  for (let step = 0; out.length < SHAPE.looseSlots; step++) {
    if (step > guard) {
      throw new Error(
        `filler capacity exhausted at ${out.length} of ${SHAPE.looseSlots} loose slots — ` +
          "add a filler value or raise FILLER_CAP",
      );
    }
    const filler = FILLER[cursor % FILLER.length]!;
    cursor++;
    const key = `${filler.kind}|${filler.value}`;
    const count = used.get(key) ?? 0;
    if (count >= FILLER_CAP) continue;
    used.set(key, count + 1);
    out.push(requestFor(filler.kind, filler.value));
  }
  return out;
}

function requestFor(kind: SlotKindLocal, value: string): SlotRequest {
  if (kind === "fill") return { kind, bound: false, raw: value };
  if (kind === "stroke") return { kind, bound: false, raw: value };
  if (kind === "effect") return { kind, bound: false, raw: value };
  if (kind === "text") {
    const [size, lh, weight, family] = parseTypeLabel(value);
    return {
      kind,
      bound: false,
      text: looseText({ fontSize: size, lineHeight: lh, fontWeight: weight, fontFamily: family }),
    };
  }
  return { kind, bound: false, value: Number.parseFloat(value) };
}

function parseTypeLabel(label: string): [number, number, number, string] {
  const [metrics, weight, ...family] = label.split(" ");
  const [size, lh] = metrics!.split("/");
  return [Number(size), Number(lh), Number(weight), family.join(" ")];
}

function boundRequests(): SlotRequest[] {
  const out: SlotRequest[] = [];
  const pattern: SlotKindLocal[] = [
    "fill",
    "gap",
    "padding",
    "radius",
    "fill",
    "text",
    "stroke",
    "padding",
    "effect",
    "fill",
  ];
  for (let i = 0; i < SHAPE.boundSlots; i++) {
    const kind = pattern[i % pattern.length]!;
    out.push(
      kind === "fill" || kind === "stroke" || kind === "effect" || kind === "text"
        ? { kind, bound: true }
        : { kind, bound: true, value: 16 },
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Packing slots into nodes
// ---------------------------------------------------------------------------

interface Carrier {
  fill?: SlotRequest;
  stroke?: SlotRequest;
  radius?: SlotRequest;
  gap?: SlotRequest;
  paddings: SlotRequest[];
  text?: SlotRequest;
  effects: SlotRequest[];
}

/**
 * A node can hold one fill, one stroke, one radius, one gap, four paddings, one
 * text and any number of effects. Requests are dealt out round-robin so a
 * cluster's 243 gradients land on 243 different layers rather than piling onto
 * one.
 */
function pack(requests: SlotRequest[], carrierCount: number): Carrier[] {
  const carriers: Carrier[] = Array.from({ length: carrierCount }, () => ({
    paddings: [],
    effects: [],
  }));

  let cursor = 0;
  for (const request of requests) {
    let placed = false;
    for (let attempt = 0; attempt < carrierCount && !placed; attempt++) {
      const carrier = carriers[(cursor + attempt) % carrierCount]!;
      placed = place(carrier, request);
      if (placed) cursor = (cursor + attempt + 1) % carrierCount;
    }
    if (!placed) throw new Error(`no carrier left for a ${request.kind} slot`);
  }
  return carriers;
}

function place(carrier: Carrier, request: SlotRequest): boolean {
  switch (request.kind) {
    case "fill":
      if (carrier.fill) return false;
      carrier.fill = request;
      return true;
    case "stroke":
      if (carrier.stroke) return false;
      carrier.stroke = request;
      return true;
    case "radius":
      if (carrier.radius) return false;
      carrier.radius = request;
      return true;
    case "gap":
      if (carrier.gap) return false;
      carrier.gap = request;
      return true;
    case "padding":
      if (carrier.paddings.length >= 4) return false;
      carrier.paddings.push(request);
      return true;
    case "text":
      if (carrier.text) return false;
      carrier.text = request;
      return true;
    case "effect":
      if (carrier.effects.length >= 2) return false;
      carrier.effects.push(request);
      return true;
  }
}

const PADDING_SIDES = ["top", "right", "bottom", "left"] as const;

function carrierToNode(carrier: Carrier, index: number, type: IRNodeType, name: string): FrameIRNode {
  const padding: Partial<Record<(typeof PADDING_SIDES)[number], TokenValue>> = {};
  carrier.paddings.forEach((request, i) => {
    const side = PADDING_SIDES[i]!;
    padding[side] = request.bound ? bound(request.value ?? 16) : loose(request.value ?? 0);
  });

  return node({
    id: `sb:${index}`,
    name,
    type,
    // A gap slot only exists on an auto-layout frame, so a carrier holding one
    // has to actually be one.
    layoutMode: carrier.gap ? "horizontal" : "none",
    ...(carrier.gap
      ? { gap: carrier.gap.bound ? bound(carrier.gap.value ?? 16, "space.4") : loose(carrier.gap.value ?? 0) }
      : {}),
    ...(carrier.fill
      ? { fill: carrier.fill.bound ? boundFill() : looseFill(carrier.fill.raw ?? "#cccccc") }
      : {}),
    ...(carrier.stroke
      ? { stroke: carrier.stroke.bound ? boundStroke() : looseStroke(carrier.stroke.raw ?? "#cccccc") }
      : {}),
    ...(carrier.radius
      ? {
          radius: carrier.radius.bound
            ? bound(carrier.radius.value ?? 8, "radius.md")
            : { value: carrier.radius.value ?? 0, unbound: (carrier.radius.value ?? 0) !== 0 },
        }
      : {}),
    ...(carrier.paddings.length > 0 ? { padding } : {}),
    ...(carrier.effects.length > 0
      ? {
          effects: carrier.effects.map((request) =>
            request.bound ? boundEffect() : looseEffect(request.raw ?? "DROP_SHADOW"),
          ),
        }
      : {}),
    ...(carrier.text
      ? { text: carrier.text.bound ? boundText() : (carrier.text.text ?? looseText()) }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

const DEFAULT_NAMES = ["Frame", "Group", "Rectangle", "Ellipse", "Vector", "Instance"];

/**
 * 1,596 nodes: the root, 79 groups, 516 layers inside them, and the rest hanging
 * off two desktop-width frames — no artboard between 320 and 480, which is what
 * B3 is looking for.
 */
export function southernBraveShape(): FrameIRDocument {
  resetIds();

  const carrierCount = SHAPE.nodeCount - 1 - SHAPE.groups - 2; // root, groups, 2 section frames
  const carriers = pack([...looseRequests(), ...boundRequests()], carrierCount);

  // 44% vectors, matching the real file, because W1's percentage excludes them
  // and the exclusion is only meaningful if there are some.
  const vectorCount = Math.round(carrierCount * 0.44);

  const leaves: FrameIRNode[] = carriers.map((carrier, index) => {
    const isVector = index < vectorCount;
    const type: IRNodeType = isVector ? "VECTOR" : index % 7 === 0 ? "INSTANCE" : "FRAME";
    return carrierToNode(carrier, index, type, nameFor(index, isVector, carrierCount, vectorCount));
  });

  // 79 groups holding 516 distinct layers: 37 groups of 6 plus 42 of 7.
  const grouped = leaves.slice(0, SHAPE.groupedLayers);
  const rest = leaves.slice(SHAPE.groupedLayers);
  const groups: FrameIRNode[] = [];
  let taken = 0;
  for (let i = 0; i < SHAPE.groups; i++) {
    const size = i < 37 ? 6 : 7;
    groups.push(
      node({
        id: `sb:group:${i}`,
        name: `Group ${i}`,
        type: "GROUP",
        children: grouped.slice(taken, taken + size),
      }),
    );
    taken += size;
  }
  if (taken !== SHAPE.groupedLayers) {
    throw new Error(`grouped ${taken} layers, expected ${SHAPE.groupedLayers}`);
  }

  const half = Math.ceil(rest.length / 2);
  const sections = [
    node({
      id: "sb:section:0",
      name: "Desktop 1366",
      type: "FRAME",
      layoutMode: "vertical",
      width: SHAPE.topLevelWidths[0],
      height: 4000,
      children: [...groups, ...rest.slice(0, half)],
    }),
    node({
      id: "sb:section:1",
      name: "Desktop 1368",
      type: "FRAME",
      layoutMode: "vertical",
      width: SHAPE.topLevelWidths[1],
      height: 4000,
      children: rest.slice(half),
    }),
  ];

  const root = withDepths(
    node({
      id: "1:4366",
      name: "Home",
      type: "FRAME",
      // B1: the root is not a vertical auto-layout frame.
      layoutMode: "none",
      width: SHAPE.topLevelWidths[0],
      height: 8000,
      children: sections,
    }),
  );

  return document(root, { pageName: "Home", rootNodeId: "1:4366" });
}

/** ~45% of non-vector layers keep the name Figma gave them. */
function nameFor(index: number, isVector: boolean, total: number, vectorCount: number): string {
  if (isVector) return `Vector ${index}`;
  const nonVectorIndex = index - vectorCount;
  const nonVectorTotal = total - vectorCount;
  const defaultShare = Math.round(nonVectorTotal * 0.45);
  if (nonVectorIndex < defaultShare) {
    return `${DEFAULT_NAMES[nonVectorIndex % DEFAULT_NAMES.length]} ${100 + nonVectorIndex}`;
  }
  return `card-${nonVectorIndex}`;
}
