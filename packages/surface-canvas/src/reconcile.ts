/**
 * Token <-> Figma variable reconciliation. FIGMA-AWARE.
 *
 * This runs before any rule can propose anything, because a proposal whose
 * token has no variable behind it is a button that fails. The theme JSON and the
 * Figma file are two separate sources of truth and they will not agree; this
 * module measures the disagreement and hands the result to the pure engine as
 * plain data.
 *
 * Three things it checks, in order of how badly each one bites:
 *
 *   1. does a variable with this name exist          -> bindable at all
 *   2. is it the right resolved type                 -> a COLOR for a colour
 *   3. does it hold the same value as the theme      -> binding won't MOVE things
 *
 * (3) is the one that matters most and is easiest to skip. A file where
 * `spacing_4` holds 20 while the theme says 16 would turn "bind 60 layers" into
 * "silently re-space 60 layers", and the designer would find out from a diff.
 * A value mismatch therefore makes the token unbindable, with both numbers in
 * the reason.
 *
 * Everything is cached in Maps for the plugin session. A real file re-references
 * the same handful of variables hundreds of times and every
 * `getVariableByIdAsync` is a round trip.
 */
import type { Breakpoint, Category, NormalizedTheme, TokenCategory } from "@fanos/tokens";
import { coalesceStops, formatNumber, toRaw } from "@fanos/tokens";
import type {
  ColorEntry,
  GradientEntry,
  NumberEntry,
  OrphanBinding,
  ShadowEntry,
  ThemeSnapshot,
  TokenBinding,
  TypeEntry,
} from "./health/types.js";
import { colorFamily } from "./match/color.js";
import { leafKeys, nameKeys } from "./health/name-keys.js";

const ALIAS_HOPS = 4;
const FLOAT_EPSILON = 0.001;

export interface LibraryVariableRef {
  name: string;
  key: string;
  resolvedType: VariableResolvedDataType;
  library: string;
  collection: string;
}

/** Everything discovered about the file, indexed for name lookup. */
export interface BindingIndex {
  variables: Map<string, Variable[]>;
  textStyles: Map<string, TextStyle[]>;
  effectStyles: Map<string, EffectStyle[]>;
  collectionNames: Map<string, string>;
  collectionDefaultMode: Map<string, string>;
  localCollections: number;
  /** Enabled libraries that publish variables. */
  libraryCollections: number;
  /** name-key -> library variable descriptor. Not imported; addressed by key. */
  libraryVariables: Map<string, LibraryVariableRef>;
  /** Why the library lookup failed, when it did. */
  libraryError: string | undefined;
  /** Every candidate, so orphans can be computed by subtraction. */
  allVariables: Variable[];
  allTextStyles: TextStyle[];
  allEffectStyles: EffectStyle[];
  /** Session cache — id -> Variable, shared with fix.ts. */
  byId: Map<string, Variable>;
}

/**
 * Builds the index from three sources, in increasing order of cost.
 *
 * 1. LOCAL COLLECTIONS — the obvious one, and on a library-driven file, empty.
 *
 * 2. VARIABLES THE PAGE ALREADY USES. A file whose variables come from a
 *    published library still holds real `Variable` objects for every one it has
 *    actually bound — that is what the traversal's id->name cache is full of.
 *    Harvesting those costs nothing, needs no permission, and on a page that is
 *    already partly bound it is usually most of the palette.
 *
 * 3. THE ENABLED LIBRARIES, by key. This is what makes a token bindable that
 *    the file has never used. Enumerating is cheap; IMPORTING is not innocent —
 *    it adds the variable to the file — so nothing is imported here. `fix.ts`
 *    imports one variable at the moment somebody binds it.
 */
export async function loadBindingIndex(
  referencedVariableIds: Iterable<string> = [],
): Promise<BindingIndex> {
  const index: BindingIndex = {
    variables: new Map(),
    textStyles: new Map(),
    effectStyles: new Map(),
    collectionNames: new Map(),
    collectionDefaultMode: new Map(),
    localCollections: 0,
    libraryCollections: 0,
    libraryVariables: new Map(),
    libraryError: undefined,
    allVariables: [],
    allTextStyles: [],
    allEffectStyles: [],
    byId: new Map(),
  };

  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  index.localCollections = collections.length;

  for (const collection of collections) {
    index.collectionNames.set(collection.id, collection.name);
    index.collectionDefaultMode.set(collection.id, collection.defaultModeId);
    for (const id of collection.variableIds) {
      const variable = await figma.variables.getVariableByIdAsync(id);
      if (!variable) continue;
      addVariable(index, variable);
    }
  }

  // (2) Variables the page is already bound to — remote ones included.
  for (const id of referencedVariableIds) {
    if (index.byId.has(id)) continue;
    try {
      const variable = await figma.variables.getVariableByIdAsync(id);
      if (!variable) continue;
      const collectionId = variable.variableCollectionId;
      if (!index.collectionNames.has(collectionId)) {
        const collection = await figma.variables.getVariableCollectionByIdAsync(collectionId);
        if (collection) {
          index.collectionNames.set(collectionId, collection.name);
          index.collectionDefaultMode.set(collectionId, collection.defaultModeId);
        }
      }
      addVariable(index, variable);
    } catch {
      // A variable the page references but this user cannot resolve. Skip it —
      // it simply will not be offered as a binding target.
    }
  }

  // (3) The enabled libraries. Descriptors only: name, key, resolved type.
  try {
    const libraries = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
    index.libraryCollections = libraries.length;
    for (const library of libraries) {
      const variables = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(library.key);
      for (const variable of variables) {
        // Leaf only. Full-path squash would make `spacing_1` and `spacing/1`
        // the same key and Bind would import the wrong published variable.
        for (const key of leafKeys(variable.name)) {
          if (!index.libraryVariables.has(key)) {
            index.libraryVariables.set(key, {
              name: variable.name,
              key: variable.key,
              resolvedType: variable.resolvedType,
              library: library.libraryName,
              collection: library.name,
            });
          }
        }
      }
    }
  } catch (err) {
    // Requires the `teamlibrary` permission and an enabled library. Neither is
    // guaranteed, and neither is fatal — the panel says so instead of failing.
    index.libraryError = err instanceof Error ? err.message : String(err);
  }

  index.allTextStyles = await figma.getLocalTextStylesAsync();
  for (const style of index.allTextStyles) {
    for (const key of nameKeys(style.name)) push(index.textStyles, key, style);
  }

  index.allEffectStyles = await figma.getLocalEffectStylesAsync();
  for (const style of index.allEffectStyles) {
    for (const key of nameKeys(style.name)) push(index.effectStyles, key, style);
  }

  return index;
}

function addVariable(index: BindingIndex, variable: Variable): void {
  rememberVariable(index, variable);
}

/**
 * An imported library variable must be findable by published key AND local id.
 * Autofix used to re-import the same token for every batch; the second import
 * often threw and the rest of that batch never bound — Bind 130 became Bind 40,
 * click again.
 */
export function rememberVariable(
  index: BindingIndex,
  variable: Variable,
  ...aliases: Array<string | undefined>
): void {
  if (!index.byId.has(variable.id)) {
    index.byId.set(variable.id, variable);
    index.allVariables.push(variable);
    for (const key of nameKeys(variable.name)) push(index.variables, key, variable);
  }
  if (variable.key) index.byId.set(variable.key, variable);
  for (const alias of aliases) {
    if (alias) index.byId.set(alias, variable);
  }
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export async function reconcile(
  theme: NormalizedTheme,
  index: BindingIndex,
): Promise<ThemeSnapshot> {
  const claimed = new Set<string>();
  let valueMismatches = 0;

  const bind = async (
    ref: string,
    category: TokenCategory,
    expected: ExpectedValue,
  ): Promise<{ raw: string; binding?: TokenBinding }> => {
    const raw = rawNameFor(theme, ref, category);
    const medium = mediumFor(category);
    const hit = lookup(index, medium, raw);
    if (!hit) return { raw };

    claimed.add(hit.id);
    const binding = await describeBinding(index, hit, medium, expected);
    if (binding.valueMatches === false) valueMismatches++;
    return { raw, binding };
  };

  const colors: ColorEntry[] = [];
  for (const [leaf, hex] of theme.color.light) {
    const ref = `color.${leaf}`;
    const { raw, binding } = await bind(ref, "color", { kind: "color", hex });
    const rgb = hexToRgbTuple(hex);
    colors.push({
      ref,
      raw,
      hex,
      rgb,
      family: colorFamily(raw),
      ...(binding ? { binding } : {}),
    });
  }

  const spaces: NumberEntry[] = [];
  for (const [leaf, px] of theme.space) {
    const ref = `space.${leaf}`;
    const { raw, binding } = await bind(ref, "space", { kind: "number", value: px });
    spaces.push({ ref, raw, px, ...(binding ? { binding } : {}) });
  }

  const radii: NumberEntry[] = [];
  for (const [leaf, px] of theme.radius) {
    const ref = `radius.${leaf}`;
    const { raw, binding } = await bind(ref, "radius", { kind: "number", value: px });
    radii.push({ ref, raw, px, ...(binding ? { binding } : {}) });
  }

  const types: TypeEntry[] = [];
  for (const leaf of typeLeaves(theme)) {
    const ref = `type.${leaf}`;
    const { raw, binding } = await bind(ref, "type", { kind: "opaque" });
    const byBreakpoint: TypeEntry["byBreakpoint"] = {};
    for (const bp of ["mobile", "tablet", "desktop"] as Breakpoint[]) {
      const style = theme.type[bp].get(leaf);
      if (style) byBreakpoint[bp] = style;
    }
    types.push({ ref, raw, byBreakpoint, ...(binding ? { binding } : {}) });
  }

  const shadows: ShadowEntry[] = [];
  for (const [leaf, shadow] of theme.shadow.light) {
    const ref = `shadow.${leaf}`;
    const { raw, binding } = await bind(ref, "shadow", { kind: "opaque" });
    shadows.push({
      ref,
      raw,
      value: `${shadow.inset ? "inset " : ""}${formatNumber(shadow.x)} ${formatNumber(shadow.y)} ${formatNumber(shadow.blur)} ${formatNumber(shadow.spread)} ${shadow.color}@${formatNumber(shadow.opacity)}%`,
      x: shadow.x,
      y: shadow.y,
      blur: shadow.blur,
      spread: shadow.spread,
      color: shadow.color,
      opacity: shadow.opacity,
      inset: shadow.inset,
      ...(binding ? { binding } : {}),
    });
  }

  const gradients: GradientEntry[] = [];
  for (const [leaf, gradient] of theme.gradient.light) {
    const ref = `gradient.${leaf}`;
    const { raw, binding } = await bind(ref, "gradient", { kind: "opaque" });
    gradients.push({
      ref,
      raw,
      value: `linear ${formatNumber(gradient.degree)}deg ${coalesceStops(gradient.stops)
        .map((s) => `${s.color}@${formatNumber(s.percent)}%`)
        .join(" ")}`,
      ...(binding ? { binding } : {}),
    });
  }

  return {
    themeId: theme.id,
    themeName: theme.name,
    slug: theme.slug,
    colors,
    spaces,
    radii,
    types,
    shadows,
    gradients,
    orphans: collectOrphans(index, claimed),
    reconciled: true,
    localCollections: index.localCollections,
    libraryCollections: index.libraryCollections,
    ...(index.libraryError ? { libraryError: index.libraryError } : {}),
    valueMismatches,
  };
}

type ExpectedValue =
  | { kind: "color"; hex: string }
  | { kind: "number"; value: number }
  // Types, shadows and gradients bind through styles, whose value cannot be
  // compared to a token without reimplementing Figma's renderer. Name match
  // only, and the panel says so.
  | { kind: "opaque" };

type Hit =
  | { medium: "variable"; id: string; variable: Variable }
  | { medium: "libraryVariable"; id: string; ref: LibraryVariableRef }
  | { medium: "textStyle"; id: string; style: TextStyle }
  | { medium: "effectStyle"; id: string; style: EffectStyle };

function mediumFor(category: Category): TokenBinding["medium"] {
  if (category === "type") return "textStyle";
  if (category === "shadow") return "effectStyle";
  return "variable";
}

function lookup(
  index: BindingIndex,
  medium: TokenBinding["medium"],
  raw: string,
): Hit | undefined {
  const keys = nameKeys(raw);

  if (medium === "variable") {
    for (const key of keys) {
      const hit = index.variables.get(key)?.[0];
      if (hit) return { medium: "variable", id: hit.id, variable: hit };
    }
    // Nothing in the file, but a library publishes one by that name. Bindable —
    // it just has to be imported first, which happens at apply time.
    // Leaf keys only — see leafKeys() — so theme `spacing_1` does not import
    // a published `spacing/1`.
    for (const key of leafKeys(raw)) {
      const ref = index.libraryVariables.get(key);
      if (ref) return { medium: "libraryVariable", id: ref.key, ref };
    }
    return undefined;
  }
  if (medium === "textStyle") {
    for (const key of keys) {
      const hit = index.textStyles.get(key)?.[0];
      if (hit) return { medium: "textStyle", id: hit.id, style: hit };
    }
    return undefined;
  }
  for (const key of keys) {
    const hit = index.effectStyles.get(key)?.[0];
    if (hit) return { medium: "effectStyle", id: hit.id, style: hit };
  }
  return undefined;
}

async function describeBinding(
  index: BindingIndex,
  hit: Hit,
  medium: TokenBinding["medium"],
  expected: ExpectedValue,
): Promise<TokenBinding> {
  if (hit.medium === "libraryVariable") {
    const ref = hit.ref;
    const binding: TokenBinding = {
      medium: "libraryVariable",
      id: ref.key,
      key: ref.key,
      figmaName: ref.name,
      collection: ref.collection,
      library: ref.library,
    };
    // A library descriptor carries a name, a key and a type — no value. The type
    // can be checked now; the VALUE cannot be read without importing, and
    // importing to look would add every token in the theme to the file. So it is
    // verified at apply time instead, and refused there if it has drifted.
    if (!libraryTypeMatches(ref.resolvedType, expected)) {
      binding.valueMatches = false;
      binding.figmaValue = `${ref.resolvedType.toLowerCase()} variable`;
    }
    return binding;
  }

  if (hit.medium !== "variable") {
    return { medium, id: hit.id, figmaName: hit.style.name };
  }

  const variable = hit.variable;
  const collection = index.collectionNames.get(variable.variableCollectionId);
  // Already in the file — including an imported library copy. Apply binds
  // through `id`. `remote` is only so Reset refuses to rewrite it.
  const binding: TokenBinding = {
    medium: "variable",
    id: variable.id,
    figmaName: variable.name,
    ...(variable.remote ? { remote: true, key: variable.key || undefined } : {}),
    ...(collection ? { collection } : {}),
  };

  if (!typeMatches(variable, expected)) {
    binding.valueMatches = false;
    binding.figmaValue = `${variable.resolvedType.toLowerCase()} variable`;
    return binding;
  }

  const resolved = await resolveValue(index, variable);
  if (resolved === undefined) return binding;

  if (expected.kind === "color" && isRgb(resolved)) {
    const hex = rgbToHex(resolved);
    binding.figmaValue = hex;
    binding.valueMatches = hex === expected.hex.toLowerCase();
  } else if (expected.kind === "number" && typeof resolved === "number") {
    binding.figmaValue = `${formatNumber(resolved)}px`;
    binding.valueMatches = Math.abs(resolved - expected.value) < FLOAT_EPSILON;
  }
  return binding;
}

function libraryTypeMatches(type: VariableResolvedDataType, expected: ExpectedValue): boolean {
  if (expected.kind === "color") return type === "COLOR";
  if (expected.kind === "number") return type === "FLOAT";
  return true;
}

function typeMatches(variable: Variable, expected: ExpectedValue): boolean {
  if (expected.kind === "color") return variable.resolvedType === "COLOR";
  if (expected.kind === "number") return variable.resolvedType === "FLOAT";
  return true;
}

/** Follows alias chains a few hops; a cycle or a deeper chain resolves to undefined. */
async function resolveValue(
  index: BindingIndex,
  variable: Variable,
): Promise<VariableValue | undefined> {
  let current: Variable | undefined = variable;
  for (let hop = 0; hop < ALIAS_HOPS && current; hop++) {
    const modeId: string | undefined =
      index.collectionDefaultMode.get(current.variableCollectionId) ??
      Object.keys(current.valuesByMode)[0];
    if (!modeId) return undefined;
    const value: VariableValue | undefined = current.valuesByMode[modeId];
    if (value === undefined) return undefined;
    if (isAlias(value)) {
      const next: Variable | null =
        index.byId.get(value.id) ?? (await figma.variables.getVariableByIdAsync(value.id));
      if (!next) return undefined;
      index.byId.set(next.id, next);
      current = next;
      continue;
    }
    return value;
  }
  return undefined;
}

function isAlias(value: VariableValue): value is VariableAlias {
  return typeof value === "object" && value !== null && (value as VariableAlias).type === "VARIABLE_ALIAS";
}

function isRgb(value: VariableValue): value is RGB | RGBA {
  return typeof value === "object" && value !== null && "r" in value;
}

function rgbToHex(color: RGB | RGBA): string {
  const channel = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

function hexToRgbTuple(hex: string): [number, number, number] {
  const n = hex.replace("#", "");
  return [
    Number.parseInt(n.slice(0, 2), 16),
    Number.parseInt(n.slice(2, 4), 16),
    Number.parseInt(n.slice(4, 6), 16),
  ];
}

/**
 * The authored raw name, from the theme's own name map where it has one. The
 * map is built from the real export, so `shadow.md` comes back as the
 * `drop_shadow_md` that was actually written rather than the default pattern.
 */
function rawNameFor(theme: NormalizedTheme, ref: string, category: TokenCategory): string {
  return theme.names.toRaw(ref, category) ?? toRaw(ref, category);
}

/** Type styles present at any breakpoint — a partial style still has a variable. */
function typeLeaves(theme: NormalizedTheme): string[] {
  const leaves = new Set<string>();
  for (const bp of ["mobile", "tablet", "desktop"] as Breakpoint[]) {
    for (const leaf of theme.type[bp].keys()) leaves.add(leaf);
  }
  return [...leaves];
}

function collectOrphans(index: BindingIndex, claimed: Set<string>): OrphanBinding[] {
  const orphans: OrphanBinding[] = [];
  for (const variable of index.allVariables) {
    if (claimed.has(variable.id)) continue;
    orphans.push({
      medium: "variable",
      figmaName: variable.name,
      resolvedType: variable.resolvedType,
      ...(index.collectionNames.has(variable.variableCollectionId)
        ? { collection: index.collectionNames.get(variable.variableCollectionId)! }
        : {}),
    });
  }
  for (const style of index.allTextStyles) {
    if (claimed.has(style.id)) continue;
    orphans.push({ medium: "textStyle", figmaName: style.name });
  }
  for (const style of index.allEffectStyles) {
    if (claimed.has(style.id)) continue;
    orphans.push({ medium: "effectStyle", figmaName: style.name });
  }
  return orphans;
}

/**
 * The snapshot to lint against when there is no file to reconcile with — every
 * token present, nothing bindable. Used by tests and by the CI gate, where the
 * question is "does the theme cover this page" rather than "can I click a
 * button".
 */
export function unreconciledSnapshot(snapshot: ThemeSnapshot): ThemeSnapshot {
  const strip = <T extends { binding?: TokenBinding }>(entries: T[]): T[] =>
    entries.map(({ binding: _binding, ...rest }) => rest as T);
  return {
    ...snapshot,
    colors: strip(snapshot.colors),
    spaces: strip(snapshot.spaces),
    radii: strip(snapshot.radii),
    types: strip(snapshot.types),
    shadows: strip(snapshot.shadows),
    gradients: strip(snapshot.gradients),
    orphans: [],
    reconciled: false,
    localCollections: 0,
    libraryCollections: 0,
    valueMismatches: 0,
  };
}
