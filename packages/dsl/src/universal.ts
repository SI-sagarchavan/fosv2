/**
 * Part 3 — Universal props.
 *
 * Carried by every node type. `id` and `src` live on the wire envelope rather
 * than in `props`, because the flat format needs them to resolve parentage
 * before it has looked at a single prop.
 *
 * Logical `start`/`end` throughout, never `left`/`right`. ICC will need RTL and
 * retrofitting direction into a shipped vocabulary is miserable.
 */

import { f, opt, req, type Fields } from "./field.js";

/**
 * Padding. One namespace with shorthand (`p`, `px`, `py`) and longhand, which
 * is the vocabulary designers already use.
 */
export const spaceFields: Fields = {
  p: opt(f.val(), { resp: true, doc: "all sides" }),
  px: opt(f.val(), { resp: true, doc: "inline (start + end)" }),
  py: opt(f.val(), { resp: true, doc: "block (top + bottom)" }),
  pt: opt(f.val(), { resp: true }),
  pr: opt(f.val(), { resp: true }),
  pb: opt(f.val(), { resp: true }),
  pl: opt(f.val(), { resp: true }),
};

export const sizeFields: Fields = {
  w: opt(f.size(), { resp: true }),
  h: opt(f.size(), { resp: true }),
  minW: opt(f.size(), { resp: true }),
  maxW: opt(f.size(), { resp: true }),
  minH: opt(f.size(), { resp: true }),
  maxH: opt(f.size(), { resp: true }),
  ratio: opt(f.ratio(), { doc: "e.g. `37/50`" }),
};

/**
 * Positioning lives on the CHILD, not the parent.
 *
 * Overlay anchoring and Grid spanning are both child-positional, so they share
 * one namespace — one thing for the agent to learn instead of two, and the
 * validator can check each against the parent's type (S6, S7).
 */
export const placeFields: Fields = {
  anchor: opt(f.anchor(), { doc: "Overlay children only" }),
  offset: opt(
    f.obj({
      block: opt(f.offset()),
      inline: opt(f.offset()),
    }),
  ),
  span: opt(f.num(true), { resp: true, doc: "Grid children only" }),
  z: opt(f.num(true), { doc: "explicit override; never a layout mechanism" }),
};

export const semanticsFields: Fields = {
  as: opt(f.str()),
  label: opt(f.str()),
  role: opt(f.str()),
};

export const metaFields: Fields = {
  derivedFrom: opt(f.str()),
  fidelity: opt(f.num()),
  note: opt(f.str()),
  /**
   * Deliberate departures from the Figma IR, each naming the conformance check
   * it answers and why. @fanos/conform downgrades a matching failure to an info
   * line instead of failing the build.
   *
   * This lives on the node rather than in a sidecar so the justification travels
   * with the thing it justifies. Real cases exist — the player cutout is
   * `contain` against the IR's CROP because our stand-in asset is a different
   * shape from the one the designer cropped — and a gate with no way to record
   * that gets switched off the first time it is inconveniently right.
   */
  deviations: opt(
    f.arr(
      f.obj({
        check: req(f.str()),
        reason: req(f.str()),
        /**
         * How many findings this waiver covers; beyond it they are errors
         * again. Without a bound, a waiver on a container is a blanket amnesty
         * for everything beneath it — the one that excuses the player card's 46
         * background vectors would also excuse the player's name going missing.
         */
        max: opt(f.num(true)),
      }),
    ),
    { doc: "each entry waives one conformance check on this node" },
  ),
};

export const REVEALS = ["none", "fade", "fade-up", "scale"] as const;
export const PLATFORMS = ["web", "native"] as const;

export const universalFields: Fields = {
  surface: opt(f.token("surface"), { resp: true }),
  space: opt(f.obj(spaceFields)),
  size: opt(f.obj(sizeFields)),
  place: opt(f.obj(placeFields)),
  reveal: opt(f.enum(...REVEALS)),
  /** Duration token (or Raw ms). Never a space token — see T5. */
  revealDelay: opt(f.val("duration"), { resp: true }),
  platform: opt(f.arr(f.enum(...PLATFORMS))),
  semantics: opt(f.obj(semanticsFields)),
  testId: opt(f.str()),
  when: opt(f.predicate(), { doc: "phase 2 — schema present, contents unvalidated" }),
  _meta: opt(f.obj(metaFields)),
};

/** The universal prop names, for S5's "Repeater carries no layout props" check. */
export const UNIVERSAL_PROP_NAMES = Object.keys(universalFields);

/**
 * What a Repeater may NOT carry. It is a fragment, not a container: it emits n
 * children into its parent's layout. Everything here would give it a box of its
 * own and quietly break `Stack > Repeater`.
 */
export const REPEATER_FORBIDDEN_PROPS = ["surface", "space", "size", "place"] as const;

/**
 * Layout props belonging to the container types.
 *
 * A fragment carrying one of these is the same mistake as carrying `space` — it
 * is reaching for a box it does not have — so S5 names it explicitly rather than
 * letting it fall through as a generic "unrecognized key", which reads like a
 * typo instead of a modelling error.
 */
export const LAYOUT_PROP_NAMES = [
  "gap",
  "direction",
  "align",
  "justify",
  "wrap",
  "columns",
  "rows",
  "columnGap",
  "rowGap",
  "minItemWidth",
] as const;
