/**
 * Look inside the pipeline: Figma IR in, DSL out, and an account of the join.
 *
 * Everything here is computed by the same code a real run uses — the compiler,
 * the fidelity gate, the DSL validator — so the page that shows it cannot
 * flatter the result. What this file adds is the JOIN those packages do not
 * publish: which IR node became which DSL node, which was absorbed into
 * another, and which went missing. Each package answers its own question; none
 * of them answers "what did the whole trip lose?", and that is the question the
 * Gaps page exists for.
 *
 * Nothing is persisted and nothing reaches the control plane. The caller
 * resolves the IR and the theme; this only reads them.
 */
import type { CompileResult } from "@fanos/compile";
import { conform, type ConformIssue } from "@fanos/conform";
import {
  allFields,
  analyze,
  hasBindings,
  isSynthetic,
  nodeSpec,
  validate,
  type FlatNode,
  type FlatTree,
  type Issue,
} from "@fanos/dsl";
import type { FrameIRDocument, FrameIRNode, TokenValue } from "@fanos/surface-canvas/ir";
import { createRegistry } from "@fanos/tokens";

import type {
  Gap,
  GapCategory,
  GapSeverity,
  InspectIssue,
  InspectResult,
  IrFacts,
  IrRow,
  IrStatus,
  Json,
  NoteRow,
  StageStats,
} from "../src/inspect-types.js";
import { countRefs, countRepeaters } from "./bindings.js";
import { runPipeline, surfacesForRender, wireTree } from "./pipeline.js";
import { renderPreview } from "./preview.js";

/** Ids shown per gap. A count says how bad; the ids say where to look. */
const IDS_PER_GAP = 12;

export interface InspectInput {
  ir: unknown;
  /** The RAW theme file — `renderPreview` re-parses it, so it travels as-is. */
  theme: unknown;
  themeSource: string;
  width?: number;
  render?: boolean;
  icons?: Readonly<Record<string, string>> | undefined;
}

export async function inspect(input: InspectInput): Promise<InspectResult> {
  const pipeline = runPipeline(input);
  const { doc, theme, compiled, surfaces } = pipeline;
  const tree = compiled.tree;

  const registry = createRegistry(theme, { surfaces });
  const validation = validate(tree, { registry });
  const gate = conform(tree, doc, { theme });
  const metrics = analyze(tree);

  const irRows = joinRows(doc, tree, gate.errors.concat(gate.warnings, gate.infos));
  const gaps = findGaps({ doc, tree, compiled, irRows, validation: validation.errors.concat(validation.warnings), gate: gate.errors.concat(gate.warnings), metrics });

  const byType: Record<string, number> = {};
  for (const n of tree.nodes) byType[n.type] = (byType[n.type] ?? 0) + 1;

  const stats: StageStats = {
    irNodes: compiled.stats.irNodes,
    irPainting: gate.summary.coverage.paints,
    emitted: compiled.stats.emitted,
    absorbed: compiled.stats.absorbed,
    coverage: {
      direct: gate.summary.coverage.direct,
      absorbed: gate.summary.coverage.absorbed,
      repeated: gate.summary.coverage.repeated,
      missing: gate.summary.coverage.missing,
    },
    byType,
    cleanup: compiled.stats.cleanup,
    tokenCoverage: metrics.tokenCoverage,
    rawValues: metrics.rawValueCount,
    maxDepth: metrics.maxDepth,
    validation: { errors: validation.errors.length, warnings: validation.warnings.length },
    conform: {
      errors: gate.errors.length,
      warnings: gate.warnings.length,
      infos: gate.infos.length,
      waived: gate.summary.waived,
    },
    bound: { refs: countRefs(tree), repeaters: countRepeaters(tree) },
  };

  const width = input.width ?? (Math.round(doc.root.geometry.relBbox.w) || doc.breakpointHint);

  const result: InspectResult = {
    doc: {
      fileName: doc.fileName,
      pageName: doc.pageName,
      rootNodeId: doc.rootNodeId,
      irVersion: doc.irVersion,
      breakpointHint: doc.breakpointHint,
      extractedAt: doc.extractedAt,
      width: Math.round(doc.root.geometry.relBbox.w),
      height: Math.round(doc.root.geometry.relBbox.h),
    },
    themeSource: input.themeSource,
    irRows,
    dsl: wireTree(tree),
    stats,
    notes: compiled.notes.map(
      (n): NoteRow => ({ kind: n.kind, irId: n.irId, nodeId: n.nodeId ?? null, message: n.message }),
    ),
    gaps,
    validation: validation.errors.concat(validation.warnings).map(fromDslIssue),
    conform: gate.errors.concat(gate.warnings, gate.infos).map(fromConformIssue),
    requiredSurfaces: compiled.requiredSurfaces.map((s) => ({ name: s.name, spec: s.spec as unknown as Json })),
    requiredAssets: compiled.requiredAssets.map((a) => a.ref),
  };

  if (input.render) {
    const rendered = await renderPreview({
      tree,
      theme: input.theme,
      surfaces: surfacesForRender(compiled),
      width,
    });
    result.html = rendered.html;
    result.width = rendered.width;
  }

  return result;
}

/* ------------------------------------------------------------------------- */
/* The join                                                                   */
/* ------------------------------------------------------------------------- */

function baseSrc(src: string): string {
  return isSynthetic(src) ? src.slice("synthetic:".length).replace(/:\d+$/, "") : src;
}

/**
 * One row per IR node, with the DSL node that accounts for it.
 *
 * The statuses mirror conform's C1 on purpose — same notion of "paints", same
 * order of reasons — so a count here and a count in the run trace cannot drift
 * apart. What C1 only COUNTS, this names per node.
 */
function joinRows(doc: FrameIRDocument, tree: FlatTree, issues: ConformIssue[]): IrRow[] {
  const claimed = new Map<string, FlatNode>();
  for (const n of tree.nodes) {
    const b = baseSrc(n.src);
    if (!claimed.has(b)) claimed.set(b, n);
  }

  // C1 names the nodes it could not account for. Any severity: a waived miss is
  // still a node the tree does not draw.
  const missing = new Set(issues.filter((i) => i.code === "C1" && i.irId).map((i) => i.irId as string));

  const rows: IrRow[] = [];
  const stack: Array<{ node: FrameIRNode; parent: string | null; depth: number; via: FlatNode | null }> = [
    { node: doc.root, parent: null, depth: 0, via: null },
  ];

  // Depth-first, children in document order. `via` is the nearest ancestor that
  // some DSL node claims — what an absorbed node was absorbed INTO.
  while (stack.length > 0) {
    const { node, parent, depth, via } = stack.pop()!;
    const own = claimed.get(node.id) ?? null;

    let status: IrStatus;
    let dsl: string[] = [];
    if (own) {
      status = "direct";
      dsl = [own.id];
    } else if (missing.has(node.id)) {
      status = "missing";
    } else if (!paintsInk(node)) {
      status = "scaffold";
      if (via) dsl = [via.id];
    } else {
      status = "absorbed";
      if (via) dsl = [via.id];
    }

    rows.push({
      id: node.id,
      parent,
      depth,
      name: node.name,
      type: node.type,
      status,
      dsl,
      ...(node.text ? { text: node.text.characters } : {}),
      box: {
        x: Math.round(node.geometry.relBbox.x),
        y: Math.round(node.geometry.relBbox.y),
        w: Math.round(node.geometry.relBbox.w),
        h: Math.round(node.geometry.relBbox.h),
      },
      facts: factsOf(node),
    });

    const next = own ?? via;
    const children = node.children ?? [];
    // Pushed reversed so the stack pops them in document order.
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i]!, parent: node.id, depth: depth + 1, via: next });
    }
  }

  return rows;
}

/** conform's `paints`, restated: it is a one-liner and not worth a second export. */
function paintsInk(n: FrameIRNode): boolean {
  if (n.opacity === 0) return false;
  if (n.text !== undefined && n.text.characters.trim() !== "") return true;
  return n.image !== undefined || n.fill !== null || n.stroke !== null || n.effects.length > 0;
}

function tokenText(v: TokenValue | null | undefined): string | undefined {
  if (!v) return undefined;
  return v.tokenRef ? `${v.tokenRef} (${v.value})` : `${v.value}${v.unbound ? " ⚠ raw" : ""}`;
}

function factsOf(n: FrameIRNode): IrFacts {
  const l = n.layout;
  const p = l.padding;
  const padding = [p.top, p.right, p.bottom, p.left];
  const unbound: string[] = [];

  if (l.gap?.unbound) unbound.push(`gap ${l.gap.value}`);
  padding.forEach((side, i) => {
    if (side.unbound) unbound.push(`padding-${["top", "right", "bottom", "left"][i]} ${side.value}`);
  });
  if (n.radius?.unbound) unbound.push(`radius ${n.radius.value}`);
  if (n.fill?.unbound) unbound.push(`fill ${n.fill.raw ?? "?"}`);
  if (n.stroke?.unbound) unbound.push(`stroke ${n.stroke.raw ?? "?"}`);
  if (n.text?.unbound) unbound.push(`text style ${n.text.fontFamily} ${n.text.fontSize}`);

  const pad = padding.some((s) => s.value !== 0)
    ? padding.every((s) => s.value === padding[0]!.value)
      ? String(padding[0]!.value)
      : padding.map((s) => s.value).join(" ")
    : undefined;

  return {
    layout: l.mode,
    sizing: `${l.sizing.w}×${l.sizing.h}${l.positioning === "absolute" ? " · abs" : ""}`,
    ...(l.gap ? { gap: tokenText(l.gap) as string } : {}),
    ...(pad ? { padding: pad } : {}),
    ...(n.fill ? { fill: n.fill.tokenRef ?? n.fill.styleRef ?? n.fill.raw ?? "?" } : {}),
    ...(n.stroke ? { stroke: `${n.stroke.tokenRef ?? n.stroke.raw ?? "?"} ${n.stroke.weight}px` } : {}),
    ...(n.radius ? { radius: tokenText(n.radius) as string } : {}),
    effects: n.effects.length,
    opacity: n.opacity,
    rotation: n.geometry.rotation,
    clips: n.clipsContent,
    repeatedSiblings: n.repeatedSiblings,
    ...(n.componentKey ? { componentKey: n.componentKey } : {}),
    ...(n.text
      ? { font: `${n.text.fontFamily} ${n.text.fontWeight} ${n.text.fontSize}${n.text.styleRef ? ` · ${n.text.styleRef}` : ""}` }
      : {}),
    ...(n.text?.textCase ? { textCase: n.text.textCase } : {}),
    ...(n.text?.truncation ? { truncation: `${n.text.truncation}${n.text.maxLines ? ` ${n.text.maxLines} lines` : ""}` } : {}),
    ...(n.background ? { background: `${n.background.name} (${n.background.fit ?? "cover"})` } : {}),
    unbound,
  };
}

/* ------------------------------------------------------------------------- */
/* Gaps                                                                       */
/* ------------------------------------------------------------------------- */

interface GapInput {
  doc: FrameIRDocument;
  tree: FlatTree;
  compiled: CompileResult;
  irRows: IrRow[];
  validation: Issue[];
  gate: ConformIssue[];
  metrics: ReturnType<typeof analyze>;
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Props that carry words a reader sees. */
const TEXT_PROPS = ["content", "label", "alt"] as const;

function findGaps(input: GapInput): Gap[] {
  const { doc, tree, compiled, irRows, validation, gate, metrics } = input;
  const gaps: Gap[] = [];
  let seq = 0;

  const add = (
    category: GapCategory,
    severity: GapSeverity,
    title: string,
    detail: string,
    irIds: string[] = [],
    dslIds: string[] = [],
    fix?: string,
    count = Math.max(irIds.length, dslIds.length, 1),
  ): void => {
    gaps.push({
      id: `g${++seq}`,
      category,
      severity,
      title,
      detail,
      count,
      irIds: [...new Set(irIds)].slice(0, IDS_PER_GAP),
      dslIds: [...new Set(dslIds)].slice(0, IDS_PER_GAP),
      ...(fix ? { fix } : {}),
    });
  };

  const rowById = new Map(irRows.map((r) => [r.id, r]));
  const dslBySrc = new Map<string, FlatNode>();
  for (const n of tree.nodes) {
    const b = baseSrc(n.src);
    if (!dslBySrc.has(b)) dslBySrc.set(b, n);
  }
  const irById = new Map<string, FrameIRNode>();
  const index = (n: FrameIRNode): void => {
    irById.set(n.id, n);
    for (const c of n.children ?? []) index(c);
  };
  index(doc.root);

  /* --- content: did every word survive? ---------------------------------- */
  const spoken = new Set<string>();
  for (const n of tree.nodes) {
    for (const prop of TEXT_PROPS) {
      const v = n.props[prop];
      if (typeof v === "string" && v.trim() !== "") spoken.add(norm(v));
    }
  }

  // Text the compiler dropped for want of a type token already has its own gap,
  // at error severity. Counting it again as "appears nowhere" is the same
  // finding three times (here, in C1, and in the note) and buries the others.
  const dropped = new Set(compiled.notes.filter((n) => n.kind === "unresolved-text-style").map((n) => n.irId));

  const lost: string[] = [];
  const changed: string[] = [];
  for (const row of irRows) {
    if (row.type !== "TEXT" || !row.text || row.text.trim() === "") continue;
    const mine = norm(row.text);
    const own = dslBySrc.get(row.id);
    if (own) {
      const carried = TEXT_PROPS.map((p) => own.props[p]).find((v) => typeof v === "string");
      // A direct node that carries no text of its own is a Button or Link whose
      // label came from elsewhere; if the words are anywhere, they survived.
      if (typeof carried === "string" ? norm(carried) !== mine && !spoken.has(mine) : !spoken.has(mine)) {
        changed.push(row.id);
      }
    } else if (!spoken.has(mine) && !dropped.has(row.id)) {
      lost.push(row.id);
    }
  }
  if (lost.length > 0) {
    add(
      "content",
      "error",
      `${lost.length} text layer${lost.length === 1 ? "" : "s"} from the design ${lost.length === 1 ? "appears" : "appear"} nowhere in the tree`,
      `Words the designer typed that no Text, Button, Link or Tag carries. Sample: ${lost
        .slice(0, 3)
        .map((id) => `"${truncate(rowById.get(id)?.text ?? "", 40)}"`)
        .join(", ")}.`,
      lost,
      [],
      "Check the layer is visible and not inside a hidden or absorbed icon group.",
    );
  }
  if (changed.length > 0) {
    add(
      "content",
      "warning",
      `${changed.length} text layer${changed.length === 1 ? "" : "s"} read differently in the tree`,
      "The node that draws the layer carries other words than the layer does.",
      changed,
      changed.map((id) => dslBySrc.get(id)?.id).filter((x): x is string => Boolean(x)),
    );
  }

  /* --- coverage: from the gate ------------------------------------------- */
  const c1 = gate.filter((i) => i.code === "C1" && i.irId);
  if (c1.length > 0) {
    add(
      "coverage",
      "error",
      `${c1.length} painting layer${c1.length === 1 ? "" : "s"} no DSL node accounts for`,
      "Conform C1. Each of these puts ink on the screen in Figma and nothing in the tree draws it." +
        (c1.filter((i) => dropped.has(i.irId as string)).length > 0
          ? ` ${c1.filter((i) => dropped.has(i.irId as string)).length} of them are the dropped text layers below.`
          : ""),
      c1.map((i) => i.irId as string),
      [],
      "Usually an image or a vector the compiler could not classify. Mark it as an asset in Surface Canvas, or declare a deviation with a reason.",
    );
  }
  for (const code of ["C2", "C3", "C4", "C5"] as const) {
    const hits = gate.filter((i) => i.code === code);
    if (hits.length === 0) continue;
    const titles = {
      C2: "geometry — rendered box differs from the IR",
      C3: "sizing — a hardcoded px where the IR says hug or fill",
      C4: "snapping — a raw value that equals an existing token",
      C5: "src — a Figma id is missing, malformed or duplicated",
    } as const;
    add(
      code === "C4" ? "tokens" : "coverage",
      hits.some((h) => h.severity === "error") ? "error" : "warning",
      `${hits.length} × ${titles[code]}`,
      hits[0]?.message ?? "",
      hits.flatMap((h) => (h.irId ? [h.irId] : [])),
      hits.flatMap((h) => (h.nodeId ? [h.nodeId] : [])),
    );
  }

  /* --- vocabulary: things the DSL has no way to say ----------------------- */
  const dimmed: string[] = [];
  const turned: string[] = [];
  const shadowed: string[] = [];
  for (const row of irRows) {
    const own = dslBySrc.get(row.id);
    if (!own) continue;
    const ir = irById.get(row.id);
    if (!ir) continue;

    if (ir.opacity > 0 && ir.opacity < 1) {
      const spec = nodeSpec(own.type);
      if (!spec || !("opacity" in allFields(spec))) dimmed.push(row.id);
    }

    const turn = ir.geometry.rotation;
    if (Math.abs(turn) > 0.5) {
      const quarter = [90, 270, -90].some((q) => Math.abs(turn - q) < 0.5);
      const expressed = own.type === "Divider" || (own.type === "Text" && quarter && own.props.orientation !== undefined);
      if (!expressed) turned.push(row.id);
    }

    if (ir.effects.length > 0 && own.props.surface === undefined && own.type !== "Divider") {
      shadowed.push(row.id);
    }
  }
  if (dimmed.length > 0) {
    add(
      "vocabulary",
      "warning",
      `${dimmed.length} layer${dimmed.length === 1 ? "" : "s"} below 100% opacity, on a node type with no opacity prop`,
      "Only Divider carries opacity. Unless the alpha is baked into the fill, these render fully opaque.",
      dimmed,
      dimmed.map((id) => dslBySrc.get(id)?.id).filter((x): x is string => Boolean(x)),
      "Bake the alpha into the fill colour in Figma, or add `opacity` to the universal props.",
    );
  }
  if (turned.length > 0) {
    add(
      "vocabulary",
      "warning",
      `${turned.length} rotated layer${turned.length === 1 ? "" : "s"} the DSL cannot turn`,
      "The compiler uses rotation only to size a box correctly (a quarter-turned rule keeps its true length). It never sets Text.orientation and no other node can be rotated, so these render upright.",
      turned,
      turned.map((id) => dslBySrc.get(id)?.id).filter((x): x is string => Boolean(x)),
      "Export the rotated artwork as an image asset, emit Text.orientation for quarter turns, or add a `rotate` universal prop.",
    );
  }
  if (shadowed.length > 0) {
    add(
      "vocabulary",
      "info",
      `${shadowed.length} layer${shadowed.length === 1 ? "" : "s"} with effects and no surface to carry them`,
      "Shadows and blurs reach the tree only through a `surface`. These nodes have effects in Figma and no surface here.",
      shadowed,
      shadowed.map((id) => dslBySrc.get(id)?.id).filter((x): x is string => Boolean(x)),
    );
  }

  const broken = irRows.filter((r) => irById.get(r.id)?.extractionError);
  if (broken.length > 0) {
    add(
      "vocabulary",
      "error",
      `${broken.length} layer${broken.length === 1 ? "" : "s"} the plugin could not read`,
      `Extraction threw on these nodes, so the IR holds a stub: ${irById.get(broken[0]!.id)?.extractionError}`,
      broken.map((r) => r.id),
    );
  }

  /* --- tokens: raw values ------------------------------------------------ */
  const raw = metrics.rawValueCount;
  if (raw.total > 0) {
    add(
      "tokens",
      raw.total > 25 ? "warning" : "info",
      `${raw.total} raw value${raw.total === 1 ? "" : "s"} where a token should be`,
      `space ${raw.space} · colour ${raw.color} · size ${raw.size} · duration ${raw.duration} · other ${raw.other}. ` +
        `Token coverage ${(metrics.tokenCoverage * 100).toFixed(1)}%.`,
      [],
      [],
      "Bind the value to a variable in Figma — the Health tab lists them by frequency.",
      raw.total,
    );
  }
  const unboundRows = irRows.filter((r) => r.facts.unbound.length > 0);
  if (unboundRows.length > 0) {
    add(
      "tokens",
      "info",
      `${unboundRows.length} IR layer${unboundRows.length === 1 ? "" : "s"} carry values with no variable behind them`,
      unboundRows
        .slice(0, 3)
        .map((r) => `${r.name}: ${r.facts.unbound.join(", ")}`)
        .join(" · "),
      unboundRows.map((r) => r.id),
    );
  }

  /* --- judgment: what the compiler decided for the designer --------------- */
  const byKind = new Map<string, typeof compiled.notes>();
  for (const note of compiled.notes) {
    const list = byKind.get(note.kind) ?? [];
    list.push(note);
    byKind.set(note.kind, list);
  }
  const judgment: Record<string, { severity: GapSeverity; title: string; fix?: string }> = {
    "unknown-icon": {
      severity: "warning",
      title: "icon names the registry does not know",
      fix: "Map the layer name to a registry glyph (the `icons` map), or add the glyph.",
    },
    "unmapped-component": {
      severity: "info",
      title: "Figma components compiled as plain frames",
      fix: "Name the component `atom_button` to declare a Button — the only primitive that can be declared today — or map its componentKey.",
    },
    // Not a judgment so much as a loss: `compile` returns false for the node, so
    // the words are DROPPED, not rendered in a nearest style. The note is all that is left.
    "unresolved-text-style": {
      severity: "error",
      title: "text layers DROPPED — no type token resolves for them",
      fix: "Bind the text to a Figma text style (or add the type token). Until then the words are not in the tree at all.",
    },
    "unresolved-paint": { severity: "warning", title: "paints with no resolvable colour token" },
    "decorative-vector": { severity: "info", title: "decorative vectors dropped" },
    "crop-dropped": { severity: "info", title: "image crops dropped" },
    "pinned-size": { severity: "info", title: "boxes pinned to a pixel size" },
    "new-surface": { severity: "info", title: "surfaces the theme does not have yet" },
    "background-asset": { severity: "info", title: "marked background assets" },
    "fluid-band": { severity: "info", title: "bands made fluid" },
    absorbed: { severity: "info", title: "layers folded into their parent" },
    "zero-props": { severity: "info", title: "empty prop objects removed" },
    "unsupported-type": { severity: "warning", title: "node types the compiler does not handle" },
  };
  for (const [kind, notes] of byKind) {
    const meta = judgment[kind] ?? { severity: "info" as const, title: kind };
    add(
      "judgment",
      meta.severity,
      `${notes.length} × ${meta.title}`,
      notes[0]?.message ?? "",
      notes.map((n) => n.irId),
      notes.flatMap((n) => (n.nodeId ? [n.nodeId] : [])),
      meta.fix,
      notes.length,
    );
  }

  /* --- validity ---------------------------------------------------------- */
  const errors = validation.filter((i) => i.severity === "error");
  if (errors.length > 0) {
    add(
      "validity",
      "error",
      `${errors.length} DSL validation error${errors.length === 1 ? "" : "s"}`,
      errors
        .slice(0, 3)
        .map((e) => `${e.code}: ${e.message}`)
        .join(" · "),
      [],
      errors.flatMap((e) => (e.nodeId ? [e.nodeId] : [])),
      undefined,
      errors.length,
    );
  }

  /* --- logic: what is frozen --------------------------------------------- */
  const literalText = tree.nodes.filter(
    (n) => (n.type === "Text" || n.type === "Button" || n.type === "Link" || n.type === "Tag") && !hasBindings({ ...tree, nodes: [n] }),
  );
  if (literalText.length > 0 && !hasBindings(tree)) {
    add(
      "logic",
      "warning",
      "Every word and image in the tree is the design's placeholder",
      `${literalText.length} text-bearing nodes keep Figma's literal characters. The compiler never binds, by design — so a published page shows the mock-up's copy until a binding plan is applied.`,
      [],
      literalText.map((n) => n.id),
      "Open the Data & logic page: it proposes a binding plan from the tree and a sample API response.",
      literalText.length,
    );
  }
  const slots = tree.nodes.filter((n) => n.type === "Image" && typeof n.props.src === "string" && !/\{/.test(n.props.src as string));
  if (slots.length > 0) {
    add(
      "logic",
      "info",
      `${slots.length} image${slots.length === 1 ? "" : "s"} with a fixed source`,
      "Content images keep the URL or placeholder the compiler wrote. A CMS-driven image needs its `src` bound.",
      [],
      slots.map((n) => n.id),
    );
  }
  const inert = tree.nodes.filter((n) => n.type === "Button" && (n.props.action as { kind?: string } | undefined)?.kind === "none");
  if (inert.length > 0) {
    add(
      "logic",
      "warning",
      `${inert.length} button${inert.length === 1 ? "" : "s"} that do nothing`,
      "The compiler cannot know where a button goes. Every Button comes out with action `none` until someone sets a destination.",
      [],
      inert.map((n) => n.id),
      "Set `action` to navigate, open, submit or custom — the renderer honours navigate and submit today; `open` and `custom` need a handler.",
    );
  }

  const order = { error: 0, warning: 1, info: 2 } as const;
  return gaps.sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

function fromDslIssue(i: Issue): InspectIssue {
  return {
    code: i.code,
    severity: i.severity === "error" ? "error" : "warning",
    ...(i.nodeId ? { nodeId: i.nodeId } : {}),
    message: i.path ? `${i.path} — ${i.message}` : i.message,
  };
}

function fromConformIssue(i: ConformIssue): InspectIssue {
  return {
    code: i.code,
    severity: i.severity,
    ...(i.nodeId ? { nodeId: i.nodeId } : {}),
    ...(i.irId ? { irId: i.irId } : {}),
    message: i.message,
    ...(i.waived ? { waived: i.waived } : {}),
  };
}
