/**
 * What `POST /v1/inspect` and `POST /v1/bindings` answer with.
 *
 * Types only — the server builds these from the real compiler, the real gate and
 * the real DSL validator, and the pages render them. Nothing here is computed in
 * the browser, so the inspector cannot disagree with the pipeline it inspects.
 */

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** A DSL node as it travels on the wire (`@fanos/dsl` FlatNode). */
export interface DslNode {
  id: string;
  type: string;
  parent: string | null;
  idx: number;
  /** The Figma node id this node draws, or `synthetic:…`. */
  src: string;
  props: Record<string, Json>;
}

export interface DslTree {
  schemaVersion: string;
  nodes: DslNode[];
}

/**
 * How the DSL accounts for one IR node.
 *
 *   direct     a DSL node names it as its `src`
 *   absorbed   something that DOES have a node covers it — a leaf swallowing its
 *              subtree, a surface standing in for a plate, a Repeater template
 *   missing    it paints and nothing covers it (conform C1)
 *   scaffold   it puts no ink on screen, so the tree is free to drop it
 */
export type IrStatus = "direct" | "absorbed" | "missing" | "scaffold";

export interface IrRow {
  id: string;
  parent: string | null;
  depth: number;
  name: string;
  type: string;
  status: IrStatus;
  /** DSL node ids: the node that draws it (direct) or covers it (absorbed). */
  dsl: string[];
  /** Text content, for TEXT nodes. */
  text?: string;
  box: { x: number; y: number; w: number; h: number };
  facts: IrFacts;
}

/** The properties of an IR node worth reading beside its DSL counterpart. */
export interface IrFacts {
  layout: string;
  sizing: string;
  gap?: string;
  padding?: string;
  fill?: string;
  stroke?: string;
  radius?: string;
  effects: number;
  opacity: number;
  rotation: number;
  clips: boolean;
  repeatedSiblings: number;
  componentKey?: string;
  font?: string;
  textCase?: string;
  truncation?: string;
  background?: string;
  /** Any value on this node with a number but no token behind it. */
  unbound: string[];
}

export type GapSeverity = "error" | "warning" | "info";

/**
 * One thing the pipeline lost, guessed, or cannot say.
 *
 * `category` is the question the reader is asking:
 *   content     did a word from the design make it into the tree?
 *   coverage    did a thing that paints make it into the tree?
 *   vocabulary  does the DSL have a way to say it at all?
 *   tokens      did a value land on a token, or as a raw number?
 *   judgment    what did the compiler decide for the designer?
 *   validity    is the tree legal?
 *   logic       what is static that a page would expect to be live?
 */
export type GapCategory =
  | "content"
  | "coverage"
  | "vocabulary"
  | "tokens"
  | "judgment"
  | "validity"
  | "logic";

export interface Gap {
  id: string;
  category: GapCategory;
  severity: GapSeverity;
  title: string;
  detail: string;
  count: number;
  /** Figma ids, capped. */
  irIds: string[];
  /** DSL node ids, capped. */
  dslIds: string[];
  /** What to do about it, when there is a known answer. */
  fix?: string;
}

export interface NoteRow {
  kind: string;
  irId: string;
  nodeId: string | null;
  message: string;
}

export interface StageStats {
  irNodes: number;
  irPainting: number;
  emitted: number;
  absorbed: number;
  coverage: { direct: number; absorbed: number; repeated: number; missing: number };
  byType: Record<string, number>;
  cleanup: { cropsDropped: number; rawsDropped: number; zeroProps: number };
  tokenCoverage: number;
  rawValues: { space: number; color: number; size: number; duration: number; other: number; total: number };
  maxDepth: number;
  validation: { errors: number; warnings: number };
  conform: { errors: number; warnings: number; infos: number; waived: number };
  bound: { refs: number; repeaters: number };
}

export interface InspectIssue {
  code: string;
  severity: GapSeverity;
  nodeId?: string;
  irId?: string;
  message: string;
  waived?: string;
}

export interface InspectResult {
  doc: {
    fileName: string;
    pageName: string;
    rootNodeId: string;
    irVersion: string;
    breakpointHint: number;
    extractedAt: string;
    width: number;
    height: number;
  };
  /** Where the theme came from, so a result is never silently against the wrong one. */
  themeSource: string;
  irRows: IrRow[];
  dsl: DslTree;
  stats: StageStats;
  notes: NoteRow[];
  gaps: Gap[];
  validation: InspectIssue[];
  conform: InspectIssue[];
  requiredSurfaces: Array<{ name: string; spec: Json }>;
  requiredAssets: string[];
  /** Present when the request asked for a render. */
  html?: string;
  width?: number;
}

/* ------------------------------------------------------------------------- */

/** A reference to data that a tree prop makes, e.g. `{article.headline}`. */
export interface BoundRef {
  nodeId: string;
  prop: string;
  path: string;
  /** Resolved against the sample, or null when no sample was given. */
  resolved: boolean | null;
  /** The first resolved value, for a glance. */
  sample?: string;
}

export interface RepeaterRow {
  nodeId: string;
  over: string;
  as: string;
  slice?: [number, number];
  limit?: number;
  /** Items the sample has at `over`, or null with no sample. */
  items: number | null;
}

export interface ProposalRow {
  parentId: string;
  templateId: string;
  memberIds: string[];
  count: number;
  nodesSaved: number;
  /** Per template node, the props that differ across members and their values. */
  varying: Array<{ nodeId: string; prop: string; values: string[] }>;
}

export interface ShapePath {
  path: string;
  type: "string" | "number" | "boolean" | "null" | "object" | "array";
  sample?: string;
  /** Array length, for `array`. */
  length?: number;
  /** Whether a tree prop names this path. */
  used: boolean;
  /** What an unused field would most naturally become. A hint, never a decision. */
  hint?: "Text" | "Image" | "Link" | "date" | "when";
}

export interface Suggestion {
  kind: "bind" | "collapse";
  /** Human line: `"VIEW MORE" → news.cta`. */
  summary: string;
  /** How sure: exact literal match, order-aligned list, or ambiguous. */
  basis: "exact" | "aligned" | "ambiguous";
  /** Entry for the plan, ready to merge. */
  entry: PlanBindingWire | PlanCollapseWire;
}

export interface PlanBindingWire {
  src: string;
  prop: string;
  path: string;
}

export interface PlanCollapseWire {
  over: string;
  as: string;
  slice?: [number, number];
  members: string[];
  fields?: PlanBindingWire[];
}

export interface PlanWire {
  bind?: PlanBindingWire[];
  collapse?: PlanCollapseWire[];
  note?: string;
}

export interface BindingsResult {
  refs: BoundRef[];
  repeaters: RepeaterRow[];
  proposals: ProposalRow[];
  shape: ShapePath[];
  suggestions: Suggestion[];
  /** Paths the tree asks for that the sample does not have. */
  unresolved: string[];
  /** Scalar paths in the sample that nothing reads — API fields with no UI yet. */
  unused: string[];
  /** What applying the plan did, when one was sent. */
  applied?: { bound: number; collapsed: number; drift: Array<{ reason: string; src: string; message: string }> };
  /** The tree after the plan — what is actually rendered. */
  dsl: DslTree;
  html?: string;
  width?: number;
}
