/**
 * Creating the variables a theme expects. FIGMA-AWARE.
 *
 * This is the one operation in the plugin that adds design-system infrastructure
 * to somebody's file rather than describing what is already there, so it is
 * deliberately NOT folded into Autofix as a side effect. It is its own named
 * action, it says how many and into which collection before it runs, and it is
 * one undo step like everything else.
 *
 * Three rules it holds to:
 *
 *   ONLY WHAT IS ASKED FOR. It creates the variables the current fix queue is
 *   actually blocked on, never the whole theme. Dumping 252 variables into a
 *   file to unlock four batches is not a favour.
 *
 *   NEVER OVERWRITE. If a variable with that name already exists — in any
 *   collection, local or imported — it is left exactly as it is. A name collision
 *   is the designer's decision to make, not ours, and silently rewriting one
 *   would change every layer already bound to it.
 *
 *   THE THEME'S VALUES, EXACTLY. `space.4` is created holding 16, because the
 *   entire point of the token is that the two agree. Reconciliation will check
 *   this on the next pass like any other variable.
 */
import type { NumberEntry, ColorEntry, ThemeSnapshot } from "./health/types.js";
import type { BindingIndex } from "./reconcile.js";
import { errorMessage } from "./traverse";

export interface CreateVariablesResult {
  created: Array<{ ref: string; figmaName: string }>;
  skipped: Array<{ ref: string; reason: string }>;
  collectionName: string;
}

/**
 * Figma groups variables with "/" in the name, which is how a real design system
 * organises them — and reconciliation matches on the leaf, so
 * `Radius/radius_none` is found by a lookup for `radius_none`.
 */
const GROUPS: Record<string, string> = {
  space: "Spacing",
  radius: "Radius",
  color: "Color",
};

export async function createMissingVariables(
  refs: readonly string[],
  snapshot: ThemeSnapshot,
  index: BindingIndex,
): Promise<CreateVariablesResult> {
  const result: CreateVariablesResult = {
    created: [],
    skipped: [],
    collectionName: snapshot.themeName,
  };
  if (refs.length === 0) return result;

  const plan = refs.map((ref) => planFor(ref, snapshot)).filter(isPlanned);
  for (const ref of refs) {
    if (!plan.some((item) => item.ref === ref)) {
      result.skipped.push({
        ref,
        reason: "only colours, spacing and radii can be Figma variables",
      });
    }
  }
  if (plan.length === 0) return result;

  const collection = await findOrCreateCollection(snapshot.themeName);
  result.collectionName = collection.name;
  const modeId = collection.defaultModeId;

  // One undo step, like every other write in this plugin.
  figma.commitUndo();
  for (const item of plan) {
    try {
      // Never overwrite. An existing name belongs to whoever made it.
      if (index.variables.has(item.figmaName.split("/").pop()!.toLowerCase())) {
        result.skipped.push({ ref: item.ref, reason: "a variable with that name already exists" });
        continue;
      }
      const variable = figma.variables.createVariable(item.figmaName, collection, item.type);
      variable.setValueForMode(modeId, item.value);
      result.created.push({ ref: item.ref, figmaName: item.figmaName });
    } catch (err) {
      result.skipped.push({ ref: item.ref, reason: errorMessage(err) });
    }
  }
  figma.commitUndo();

  return result;
}

interface Planned {
  ref: string;
  figmaName: string;
  type: VariableResolvedDataType;
  value: VariableValue;
}

function isPlanned(item: Planned | null): item is Planned {
  return item !== null;
}

function planFor(ref: string, snapshot: ThemeSnapshot): Planned | null {
  const color = snapshot.colors.find((entry) => entry.ref === ref);
  if (color) {
    return {
      ref,
      figmaName: `${GROUPS["color"]}/${color.raw}`,
      type: "COLOR",
      value: hexToFigmaRgb(color.hex),
    };
  }

  const space = snapshot.spaces.find((entry) => entry.ref === ref);
  if (space) return numberPlan(ref, space, "space");

  const radius = snapshot.radii.find((entry) => entry.ref === ref);
  if (radius) return numberPlan(ref, radius, "radius");

  // Type and shadow bind through STYLES, not variables, and a style cannot be
  // synthesised from a token without also choosing a font stack and an elevation
  // model. Out of scope, and said so rather than half-done.
  return null;
}

function numberPlan(ref: string, entry: NumberEntry, category: "space" | "radius"): Planned {
  return {
    ref,
    figmaName: `${GROUPS[category]}/${entry.raw}`,
    type: "FLOAT",
    value: entry.px,
  };
}

async function findOrCreateCollection(name: string): Promise<VariableCollection> {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const existing = collections.find((collection) => collection.name === name);
  if (existing) return existing;
  return figma.variables.createVariableCollection(name);
}

function hexToFigmaRgb(hex: string): RGBA {
  const value = hex.replace("#", "");
  const channel = (start: number) => Number.parseInt(value.slice(start, start + 2), 16) / 255;
  return { r: channel(0), g: channel(2), b: channel(4), a: 1 };
}

/**
 * Rewrite drifted LOCAL variables to the theme's values. Library variables are
 * skipped — we do not own them, and rewriting one would change every file
 * that consumes the library.
 */
export async function resetDriftedVariables(
  refs: readonly string[],
  snapshot: ThemeSnapshot,
  index: BindingIndex,
): Promise<CreateVariablesResult> {
  const result: CreateVariablesResult = {
    created: [],
    skipped: [],
    collectionName: snapshot.themeName,
  };

  figma.commitUndo();
  for (const ref of refs) {
    const plan = planFor(ref, snapshot);
    if (!plan) {
      result.skipped.push({ ref, reason: "only colours, spacing and radii can be rewritten" });
      continue;
    }
    const entry =
      snapshot.colors.find((item) => item.ref === ref) ??
      snapshot.spaces.find((item) => item.ref === ref) ??
      snapshot.radii.find((item) => item.ref === ref);
    const binding = entry?.binding;
    if (!binding) {
      result.skipped.push({ ref, reason: "no Figma variable behind this token" });
      continue;
    }
    if (binding.medium === "libraryVariable" || binding.remote) {
      result.skipped.push({ ref, reason: "library variables aren't ours to rewrite" });
      continue;
    }
    const variable =
      index.byId.get(binding.id) ?? (await figma.variables.getVariableByIdAsync(binding.id));
    if (!variable) {
      result.skipped.push({ ref, reason: "the variable has gone from the file" });
      continue;
    }
    if (variable.remote) {
      result.skipped.push({ ref, reason: "imported library variables are read-only here" });
      continue;
    }
    try {
      const collection = await figma.variables.getVariableCollectionByIdAsync(
        variable.variableCollectionId,
      );
      const modeId = collection?.defaultModeId ?? Object.keys(variable.valuesByMode)[0];
      if (!modeId) {
        result.skipped.push({ ref, reason: "no mode to write" });
        continue;
      }
      variable.setValueForMode(modeId, plan.value);
      result.created.push({ ref, figmaName: binding.figmaName });
    } catch (err) {
      result.skipped.push({ ref, reason: errorMessage(err) });
    }
  }
  figma.commitUndo();
  return result;
}

/** The colour entries a ref list refers to, for the confirmation copy. */
export function describePlan(refs: readonly string[], snapshot: ThemeSnapshot): string[] {
  return refs
    .map((ref) => {
      const color: ColorEntry | undefined = snapshot.colors.find((entry) => entry.ref === ref);
      if (color) return `${color.raw} = ${color.hex}`;
      const number =
        snapshot.spaces.find((entry) => entry.ref === ref) ??
        snapshot.radii.find((entry) => entry.ref === ref);
      return number ? `${number.raw} = ${number.px}` : ref;
    })
    .sort();
}
