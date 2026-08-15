/**
 * Applying fixes. FIGMA-AWARE, and the highest-risk file in the plugin.
 *
 * Three properties this module exists to guarantee:
 *
 * 1. ONE UNDO STEP PER BATCH.
 *    Figma does not commit plugin actions to undo history on its own; a group is
 *    everything between two `figma.commitUndo()` calls. So a batch is bracketed
 *    by commitUndo — before, to isolate it from whatever came earlier, and after,
 *    to seal it so the next batch cannot merge into it. Nothing in between calls
 *    commitUndo, ever. If a 110-layer fix took 110 Ctrl-Zs, we would terrify
 *    somebody in the first week and never get them back.
 *
 * 2. NOTHING UNATTENDED THAT ISN'T EXACT.
 *    `applyBatch` refuses a batch that is not exact-and-bindable. A near match
 *    only moves through `applyCandidate`, which requires the designer to have
 *    named the token they picked.
 *
 * 3. NO WRITES AGAINST A STALE REPORT.
 *    Every item is re-read before it is written, and skipped if the value the
 *    batch was built from is no longer there. A report is a photograph; the file
 *    kept moving after it was taken.
 *
 * All resolution — nodes, variables, fonts — happens in an async prepare phase
 * so the mutation phase is as tight as it can be.
 */
import type { Batch, FixTarget, TokenBinding } from "./health/types.js";
import { isFixProposal } from "./health/types.js";
import { sameSolid } from "./match/color.js";
import { rememberVariable, type BindingIndex } from "./reconcile.js";
import { errorMessage, topmostVisibleIndex, yieldToEventLoop } from "./traverse";

const MAX_REPORTED_FAILURES = 5;

export interface ApplyOutcome {
  applied: number;
  /** Items whose value had changed since the report was taken. */
  skipped: number;
  failed: number;
  failures: string[];
  tokenRef: string;
}

export interface ApplyOptions {
  batch: Batch;
  /** The token to bind. For a near batch this is the candidate the designer picked. */
  tokenRef: string;
  binding: TokenBinding;
  index: BindingIndex;
  /**
   * The value the theme says this token holds — `#ffffff`, `16`. Checked against
   * a freshly imported library variable before anything is written.
   */
  expected?: string;
}

/**
 * Bulk-apply a safe batch. Refuses anything that is not an exact match with a
 * bindable token — that decision belongs to {@link applyCandidate}.
 */
export async function applyBatch(options: ApplyOptions): Promise<ApplyOutcome> {
  const proposal = options.batch.proposal;
  if (!proposal || !isFixProposal(proposal)) {
    throw new Error(`${options.batch.label}: nothing to apply.`);
  }
  if (!options.batch.safe) {
    throw new Error(
      `${options.batch.label}: this batch isn't safe to apply unattended — pick a candidate instead.`,
    );
  }
  return apply(options);
}

/**
 * Apply one reviewed candidate to a whole batch. The designer has seen the
 * swatches and named a token, so bulk is fine — what was never fine was the
 * plugin choosing for them.
 */
export async function applyCandidate(options: ApplyOptions): Promise<ApplyOutcome> {
  const proposal = options.batch.proposal;
  if (!proposal || !isFixProposal(proposal)) {
    throw new Error(`${options.batch.label}: nothing to apply.`);
  }
  const candidate = proposal.candidates.find((c) => c.tokenRef === options.tokenRef);
  if (!candidate) {
    throw new Error(`${options.tokenRef} isn't one of the candidates for ${options.batch.label}.`);
  }
  if (!candidate.bindable) {
    throw new Error(`${options.tokenRef} has nothing behind it in this file.`);
  }
  return apply(options);
}

/**
 * Autofix: every safe batch, in a single undo step.
 *
 * The whole point is the bracket. Preparing all of them first and mutating
 * inside ONE commitUndo pair means 300 layers across six batches collapse into
 * one Ctrl-Z. Looping over {@link applyBatch} would have produced six.
 *
 * Anything not exact-and-bindable is skipped here, silently and by design —
 * autofix is the unattended path, and unattended never guesses.
 */
export async function applyAll(list: readonly ApplyOptions[]): Promise<ApplyOutcome> {
  const failures: string[] = [];
  await preImportLibraryBindings(list, failures);

  figma.commitUndo();
  const first = await runPrepared(list, failures);
  // A first pass that imported library tokens can leave later batches unprepared.
  // Same undo group: retry whatever is still unbound so Bind 130 is one click.
  const leftover = list.filter((options) => options.batch.safe);
  const second = leftover.length > 0 && first.applied < countItems(list)
    ? await runPrepared(leftover, failures)
    : { applied: 0, skipped: 0 };
  figma.commitUndo();

  return {
    applied: first.applied + second.applied,
    skipped: second.skipped || first.skipped,
    failed: failures.length,
    failures: failures.slice(0, MAX_REPORTED_FAILURES),
    tokenRef: `${list.length} ${list.length === 1 ? "batch" : "batches"}`,
  };
}

function countItems(list: readonly ApplyOptions[]): number {
  return list.reduce((sum, item) => sum + item.batch.items.length, 0);
}

async function preImportLibraryBindings(
  list: readonly ApplyOptions[],
  failures: string[],
): Promise<void> {
  const seen = new Set<string>();
  for (const options of list) {
    const binding = options.binding;
    if (binding.medium !== "libraryVariable") continue;
    const key = binding.key ?? binding.id;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    try {
      await resolveVariable(options);
    } catch (err) {
      pushFailure(failures, `${options.batch.label}: ${errorMessage(err)}`);
    }
  }
}

async function runPrepared(
  list: readonly ApplyOptions[],
  failures: string[],
): Promise<{ applied: number; skipped: number }> {
  const prepared: Prepared[] = [];
  let n = 0;
  for (const options of list) {
    if (!options.batch.safe) continue;
    try {
      prepared.push(await prepare(options));
    } catch (err) {
      pushFailure(failures, `${options.batch.label}: ${errorMessage(err)}`);
    }
    if (++n % 8 === 0) await yieldToEventLoop();
  }

  let applied = 0;
  let skipped = 0;
  let writes = 0;
  for (const ready of prepared) {
    skipped += ready.skipped;
    for (const failure of ready.failures) pushFailure(failures, failure);
    for (const mutate of ready.mutations) {
      try {
        mutate();
        applied++;
      } catch (err) {
        pushFailure(failures, errorMessage(err));
      }
      if (++writes % 25 === 0) await yieldToEventLoop();
    }
    for (const mutate of ready.asyncMutations) {
      try {
        await mutate();
        applied++;
      } catch (err) {
        pushFailure(failures, errorMessage(err));
      }
    }
  }
  return { applied, skipped };
}

// ---------------------------------------------------------------------------
// Phase 1 — prepare (async). Resolve everything; touch nothing.
// ---------------------------------------------------------------------------

type Mutation = () => void;

/**
 * The variable to bind, imported first if it lives in a library.
 *
 * Importing is the one thing here that changes the file beyond the layers in the
 * batch — it pulls the variable into the document — so it happens once, at the
 * moment somebody actually binds something, and never while merely checking.
 *
 * A library descriptor carries no value, so the value check that protects local
 * variables cannot run during reconciliation. It runs HERE instead, on the
 * imported variable, before a single layer is touched. Binding 110 fills to a
 * variable that turns out to be the wrong colour is the failure this exists to
 * prevent, and being late is not a reason to skip it.
 */
async function resolveVariable(options: ApplyOptions): Promise<Variable | null> {
  const { binding, index, expected } = options;

  if (binding.medium === "textStyle" || binding.medium === "effectStyle") return null;

  const existing = existingVariable(index, binding);
  if (existing) {
    rememberVariable(index, existing, binding.id, binding.key);
    await assertValueMatches(existing, expected, binding.figmaName);
    return existing;
  }

  if (binding.medium === "libraryVariable") {
    const key = binding.key ?? binding.id;
    let imported: Variable;
    try {
      imported = await figma.variables.importVariableByKeyAsync(key);
    } catch (err) {
      throw new Error(
        `Couldn't import ${binding.figmaName} from ${binding.library ?? "the library"}. ` +
          `That published key is gone — enable the library (Assets → Libraries) and hit ↻, ` +
          `or the name matched a variable that isn't in this file. ${errorMessage(err)}`,
      );
    }
    rememberVariable(index, imported, binding.id, binding.key, key);
    await assertValueMatches(imported, expected, binding.figmaName);
    return imported;
  }

  throw new Error(`Variable ${binding.figmaName} has gone from the file. Refresh and try again.`);
}

/** Prefer a variable already in the file over a library import. */
function existingVariable(index: BindingIndex, binding: TokenBinding): Variable | undefined {
  const byId = index.byId.get(binding.id);
  if (byId) return byId;
  const leaf = binding.figmaName.split("/").pop()?.toLowerCase();
  if (!leaf) return undefined;
  for (const variable of index.allVariables) {
    const name = variable.name.split("/").pop()?.toLowerCase();
    if (name === leaf) return variable;
  }
  return undefined;
}

/** Refuses the whole batch rather than moving the design to match a bad variable. */
async function assertValueMatches(
  variable: Variable,
  expected: string | undefined,
  name: string,
): Promise<void> {
  if (!expected) return;
  const modeId = Object.keys(variable.valuesByMode)[0];
  if (!modeId) return;
  const value = variable.valuesByMode[modeId];
  if (value === undefined || (typeof value === "object" && value !== null && "type" in value)) {
    // An alias, or nothing readable. Not evidence of a mismatch, so allow it.
    return;
  }

  const actual =
    typeof value === "number"
      ? String(value)
      : typeof value === "object" && value !== null && "r" in value
        ? rgbToHex(value as RGB)
        : null;
  if (actual === null) return;

  if (!sameValue(actual, expected)) {
    throw new Error(
      `${name} holds ${actual} but ${expected} was expected — binding would change the design. ` +
        "Nothing was applied.",
    );
  }
}

function sameValue(actual: string, expected: string): boolean {
  const a = Number.parseFloat(actual);
  const b = Number.parseFloat(expected);
  if (Number.isFinite(a) && Number.isFinite(b)) return Math.abs(a - b) < 0.001;
  return actual.toLowerCase() === expected.toLowerCase();
}

function rgbToHex(color: RGB): string {
  const channel = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

interface Prepared {
  mutations: Mutation[];
  skipped: number;
  failures: string[];
  /** Text and effect styles are applied through async setters — see below. */
  asyncMutations: Array<() => Promise<void>>;
}

async function apply(options: ApplyOptions): Promise<ApplyOutcome> {
  const prepared = await prepare(options);

  // --- Phase 2: mutate. No commitUndo in here. No exceptions. ---
  figma.commitUndo();
  let applied = 0;
  const failures = [...prepared.failures];

  for (const mutate of prepared.mutations) {
    try {
      mutate();
      applied++;
    } catch (err) {
      pushFailure(failures, errorMessage(err));
    }
  }
  for (const mutate of prepared.asyncMutations) {
    try {
      await mutate();
      applied++;
    } catch (err) {
      pushFailure(failures, errorMessage(err));
    }
  }
  figma.commitUndo();

  return {
    applied,
    skipped: prepared.skipped,
    failed: failures.length,
    failures: failures.slice(0, MAX_REPORTED_FAILURES),
    tokenRef: options.tokenRef,
  };
}

async function prepare(options: ApplyOptions): Promise<Prepared> {
  const { batch, binding } = options;
  const target = (batch.proposal && isFixProposal(batch.proposal) ? batch.proposal.target : null) as
    | FixTarget
    | null;
  if (!target) throw new Error(`${batch.label}: no fix target.`);

  const out: Prepared = { mutations: [], skipped: 0, failures: [], asyncMutations: [] };

  const variable = await resolveVariable(options);

  // Text styles need their font loaded before the style can be assigned, and
  // loading is per font — so it happens once here, not once per layer.
  if (target.type === "textStyle") {
    const style = await figma.getStyleByIdAsync(binding.id);
    if (!style || style.type !== "TEXT") {
      throw new Error(`Text style ${binding.figmaName} has gone from the file.`);
    }
    await figma.loadFontAsync((style as TextStyle).fontName);
  }

  for (const item of batch.items) {
    const node = await figma.getNodeByIdAsync(item.nodeId);
    if (!node || node.removed) {
      out.skipped++;
      continue;
    }
    const scene = node as SceneNode;

    try {
      const mutation = buildMutation(scene, item.propPath, target, batch, variable, binding, out);
      if (mutation === "skip") out.skipped++;
      else if (typeof mutation === "function") out.mutations.push(mutation);
    } catch (err) {
      pushFailure(out.failures, `${scene.name}: ${errorMessage(err)}`);
    }
  }

  return out;
}

function buildMutation(
  node: SceneNode,
  propPath: string,
  target: FixTarget,
  batch: Batch,
  variable: Variable | null,
  binding: TokenBinding,
  out: Prepared,
): Mutation | "skip" | undefined {
  switch (target.type) {
    case "paint":
    case "nodeField":
      // A paint or a numeric field binds to a variable and nothing else. Reaching
      // here with a style binding would mean the proposal's target and its token
      // disagree, which is a bug worth hearing about rather than a null deref.
      if (!variable) {
        throw new Error(
          `${binding.figmaName} is a ${binding.medium}, but ${propPath} binds to a variable.`,
        );
      }
      return target.type === "paint"
        ? buildPaintMutation(node, target.slot, batch, variable)
        : buildFieldMutation(node, propPath, target.field, batch, variable);
    case "textStyle":
      out.asyncMutations.push(async () => {
        const text = node as TextNode;
        await text.setTextStyleIdAsync(binding.id);
      });
      return undefined;
    case "effectStyle":
      out.asyncMutations.push(async () => {
        await (node as SceneNode & { setEffectStyleIdAsync(id: string): Promise<void> })
          .setEffectStyleIdAsync(binding.id);
      });
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Paints
// ---------------------------------------------------------------------------

function buildPaintMutation(
  node: SceneNode,
  slot: "fill" | "stroke",
  batch: Batch,
  variable: Variable,
): Mutation | "skip" {
  const key = slot === "fill" ? "fills" : "strokes";
  const holder = node as SceneNode & Record<string, unknown>;
  const paints = holder[key];
  if (!Array.isArray(paints)) return "skip";

  const index = topmostVisibleIndex(paints as Paint[]);
  if (index === undefined) return "skip";
  const paint = (paints as Paint[])[index]!;
  if (paint.type !== "SOLID") return "skip";
  if ((paint as SolidPaint).boundVariables?.color) return "skip";
  // The report is a photograph. If the colour moved since it was taken, leave it.
  if (!sameSolid(solidHex(paint), batch.currentValue)) return "skip";

  return () => {
    const current = (node as SceneNode & Record<string, unknown>)[key] as Paint[];
    const bound = figma.variables.setBoundVariableForPaint(
      current[index] as SolidPaint,
      "color",
      variable,
    );
    const next = [...current];
    next[index] = bound;
    (node as SceneNode & Record<string, unknown>)[key] = next;
  };
}

function solidHex(paint: Paint): string {
  if (paint.type !== "SOLID") return "";
  const channel = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  const hex = `#${channel(paint.color.r)}${channel(paint.color.g)}${channel(paint.color.b)}`;
  const alpha = paint.opacity ?? 1;
  return alpha >= 1 ? hex : `${hex}${channel(alpha)}`;
}

// ---------------------------------------------------------------------------
// Numeric fields
// ---------------------------------------------------------------------------

const CORNER_FIELDS = [
  "topLeftRadius",
  "topRightRadius",
  "bottomLeftRadius",
  "bottomRightRadius",
] as const;

function buildFieldMutation(
  node: SceneNode,
  propPath: string,
  field: string,
  batch: Batch,
  variable: Variable,
): Mutation | "skip" {
  const current = readNumber(node, field, propPath);
  if (current === undefined) return "skip";
  const expected = Number.parseFloat(batch.currentValue);
  if (Number.isFinite(expected) && Math.abs(current - expected) > 0.001) return "skip";

  return () => {
    const bindable = node as SceneNode & {
      setBoundVariable(field: string, variable: Variable): void;
    };
    if (field !== "cornerRadius") {
      bindable.setBoundVariable(field, variable);
      return;
    }
    // `cornerRadius` is only bindable when the four corners agree. When they
    // don't, Figma refuses it and the four individual fields are the way in.
    try {
      bindable.setBoundVariable("cornerRadius", variable);
    } catch {
      for (const corner of CORNER_FIELDS) bindable.setBoundVariable(corner, variable);
    }
  };
}

function readNumber(node: SceneNode, field: string, propPath: string): number | undefined {
  const record = node as unknown as Record<string, unknown>;
  if (field === "cornerRadius") {
    const value = record["cornerRadius"];
    if (typeof value === "number") return value;
    const topLeft = record["topLeftRadius"];
    return typeof topLeft === "number" ? topLeft : undefined;
  }
  const value = record[field];
  if (typeof value === "number") return value;
  // Defensive: a field the IR reported but the node no longer exposes (the layer
  // stopped being an auto-layout frame between lint and apply).
  void propPath;
  return undefined;
}

function pushFailure(failures: string[], message: string): void {
  if (!failures.includes(message)) failures.push(message);
}

/** The panel's Undo button. Reverts to the last `commitUndo()` — i.e. our batch. */
export function undoLastBatch(): void {
  figma.triggerUndo();
}

/**
 * Pinned text → hug height. WIDTH stays, HEIGHT follows the string.
 * That is the SSR/binding contract: a longer `{headline}` must not clip.
 */
export async function hugText(ids: readonly string[]): Promise<ApplyOutcome> {
  const prepared: Array<{ text: TextNode; fonts: FontName[] }> = [];
  const failures: string[] = [];
  let skipped = 0;

  for (const id of ids) {
    const node = await figma.getNodeByIdAsync(id);
    if (!node || node.removed || node.type !== "TEXT") {
      skipped++;
      continue;
    }
    const text = node;
    try {
      prepared.push({ text, fonts: await fontsOf(text) });
    } catch (err) {
      pushFailure(failures, `${text.name}: ${errorMessage(err)}`);
    }
  }

  for (const item of prepared) {
    for (const font of item.fonts) await figma.loadFontAsync(font);
  }

  figma.commitUndo();
  let applied = 0;
  for (const item of prepared) {
    try {
      item.text.textAutoResize = "HEIGHT";
      const sizable = item.text as TextNode & { layoutSizingVertical?: "HUG" | "FILL" | "FIXED" };
      if ("layoutSizingVertical" in sizable) sizable.layoutSizingVertical = "HUG";
      applied++;
    } catch (err) {
      pushFailure(failures, `${item.text.name}: ${errorMessage(err)}`);
    }
  }
  figma.commitUndo();

  return {
    applied,
    skipped,
    failed: failures.length,
    failures: failures.slice(0, MAX_REPORTED_FAILURES),
    tokenRef: "textAutoResize",
  };
}

async function fontsOf(text: TextNode): Promise<FontName[]> {
  if (text.fontName !== figma.mixed) return [text.fontName];
  const seen = new Map<string, FontName>();
  const segments = text.getStyledTextSegments(["fontName"]);
  for (const segment of segments) {
    const font = segment.fontName;
    seen.set(`${font.family}__${font.style}`, font);
  }
  if (seen.size === 0) throw new Error("no font on this text layer");
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// F7 — round to a whole pixel. No variable, no token.
// ---------------------------------------------------------------------------

export async function applyRound(batch: Batch): Promise<ApplyOutcome> {
  const proposal = batch.proposal;
  if (!proposal || proposal.kind !== "round") {
    throw new Error(`${batch.label}: nothing to round.`);
  }

  const out: Prepared = { mutations: [], skipped: 0, failures: [], asyncMutations: [] };
  for (const item of batch.items) {
    const node = await figma.getNodeByIdAsync(item.nodeId);
    if (!node || node.removed) {
      out.skipped++;
      continue;
    }
    const mutation = buildRoundMutation(
      node as SceneNode,
      item.propPath,
      proposal.target.field,
      batch.currentValue,
      proposal.roundedTo,
    );
    if (mutation === "skip") out.skipped++;
    else if (mutation) out.mutations.push(mutation);
  }

  figma.commitUndo();
  let applied = 0;
  const failures = [...out.failures];
  for (const mutate of out.mutations) {
    try {
      mutate();
      applied++;
    } catch (err) {
      pushFailure(failures, errorMessage(err));
    }
  }
  figma.commitUndo();

  return {
    applied,
    skipped: out.skipped,
    failed: failures.length,
    failures: failures.slice(0, MAX_REPORTED_FAILURES),
    tokenRef: String(proposal.roundedTo),
  };
}

function buildRoundMutation(
  node: SceneNode,
  propPath: string,
  field: string,
  currentValue: string,
  roundedTo: number,
): Mutation | "skip" {
  const current = readNumber(node, field, propPath);
  if (current === undefined) return "skip";
  const expected = Number.parseFloat(currentValue);
  if (Number.isFinite(expected) && Math.abs(current - expected) > 0.001) return "skip";

  return () => {
    const record = node as unknown as Record<string, unknown>;
    if (field === "cornerRadius") {
      record["cornerRadius"] = roundedTo;
      return;
    }
    record[field] = roundedTo;
  };
}

// ---------------------------------------------------------------------------
// B1 / B2 — structural. One undo step.
// ---------------------------------------------------------------------------

export async function wrapAsColumn(rootId: string): Promise<ApplyOutcome> {
  const node = await figma.getNodeByIdAsync(rootId);
  if (!node || node.removed) {
    throw new Error("That frame is gone. Refresh and try again.");
  }

  figma.commitUndo();
  let frame: FrameNode;
  if (node.type === "GROUP") {
    frame = convertOneGroup(node);
  } else if ("layoutMode" in node) {
    frame = node as FrameNode;
  } else {
    figma.commitUndo();
    throw new Error("Only a frame or a group can become a column.");
  }

  frame.layoutMode = "VERTICAL";
  figma.commitUndo();

  return { applied: 1, skipped: 0, failed: 0, failures: [], tokenRef: "layout.mode" };
}

export async function convertGroupsToFrames(ids: readonly string[]): Promise<ApplyOutcome> {
  const groups: GroupNode[] = [];
  for (const id of ids) {
    const node = await figma.getNodeByIdAsync(id);
    if (node && !node.removed && node.type === "GROUP") groups.push(node);
  }
  groups.sort((a, b) => nesting(b) - nesting(a));

  figma.commitUndo();
  let applied = 0;
  const failures: string[] = [];
  for (const group of groups) {
    try {
      if (group.removed) continue;
      convertOneGroup(group);
      applied++;
    } catch (err) {
      pushFailure(failures, errorMessage(err));
    }
  }
  figma.commitUndo();

  return {
    applied,
    skipped: ids.length - applied - failures.length,
    failed: failures.length,
    failures: failures.slice(0, MAX_REPORTED_FAILURES),
    tokenRef: "type",
  };
}

function convertOneGroup(group: GroupNode): FrameNode {
  const parent = group.parent;
  if (!parent || !("insertChild" in parent)) {
    throw new Error(`Can't convert “${group.name}” — it has no parent.`);
  }
  const index = parent.children.indexOf(group);
  const frame = figma.createFrame();
  frame.name = group.name;
  frame.resizeWithoutConstraints(Math.max(group.width, 0.01), Math.max(group.height, 0.01));
  frame.x = group.x;
  frame.y = group.y;
  frame.rotation = group.rotation;
  frame.fills = [];
  frame.clipsContent = false;
  frame.opacity = group.opacity;

  parent.insertChild(index, frame);
  const children = [...group.children];
  for (const child of children) {
    const x = child.x;
    const y = child.y;
    frame.appendChild(child);
    child.x = x;
    child.y = y;
  }
  group.remove();
  return frame;
}

function nesting(node: BaseNode): number {
  let depth = 0;
  let current: BaseNode | null = node.parent;
  while (current) {
    depth++;
    current = current.parent;
  }
  return depth;
}
