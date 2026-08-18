/**
 * Part 4 — Structural nodes (8).
 */

import { f, opt, req, type Fields } from "../field.js";

export interface NodeSpec {
  type: string;
  kind: "structural" | "leaf";
  doc: string;
  /** Node-specific props. Universal props are merged in by the registry. */
  fields: Fields;
  /**
   * A fragment emits its children into the PARENT's layout and has no box of
   * its own, so it carries no universal layout props (S5).
   */
  fragment?: boolean;
}

const ALIGN = ["start", "center", "end", "stretch", "baseline"] as const;
const JUSTIFY = ["start", "center", "end", "between", "around", "evenly"] as const;

export const STRUCTURAL_NODES: NodeSpec[] = [
  {
    type: "Box",
    kind: "structural",
    doc: "No layout algorithm. Universal props only. The div.",
    fields: {
      clip: opt(f.bool(), { doc: "default false" }),
    },
  },

  {
    type: "Stack",
    kind: "structural",
    doc: "One-dimensional flow. The workhorse container.",
    fields: {
      /**
       * Not an Overlay-only concern. Figma reports `clipsContent` on ANY frame,
       * and a design leans on it: the fixture row is 235px tall inside a 227px
       * shell precisely so the cards bleed and get cut, leaving no gap for the
       * shell colour to show through. Without this the vocabulary cannot say
       * that, and the overflow paints over whatever follows.
       */
      clip: opt(f.bool(), { doc: "default false" }),
      direction: opt(f.enum("row", "column"), { resp: true, doc: 'default "column"' }),
      gap: opt(f.val(), { resp: true }),
      align: opt(f.enum(...ALIGN), { resp: true, doc: "cross axis" }),
      justify: opt(f.enum(...JUSTIFY), { resp: true, doc: "main axis" }),
      wrap: opt(f.bool(), { resp: true }),
    },
  },

  {
    type: "Grid",
    kind: "structural",
    doc: "Two-dimensional layout. No template strings — those are raw values in disguise.",
    fields: {
      columns: req(f.union(f.num(true), f.enum("auto")), { resp: true }),
      minItemWidth: opt(f.val(), { resp: true, doc: 'required iff columns === "auto" (S9)' }),
      rows: opt(f.num(true), { resp: true }),
      gap: opt(f.val(), { resp: true }),
      columnGap: opt(f.val(), { resp: true }),
      rowGap: opt(f.val(), { resp: true }),
      align: opt(f.enum(...ALIGN), { resp: true }),
      justify: opt(f.enum(...JUSTIFY), { resp: true }),
    },
  },

  {
    type: "Section",
    kind: "structural",
    doc: "A top-level page band. The only node an editor reorders in Admin, so its id must derive from its Figma node id and survive regeneration.",
    fields: {
      width: req(f.enum("full", "wide", "content", "narrow")),
      gap: opt(f.val(), { resp: true }),
      backdrop: opt(f.token("surface"), { resp: true, doc: "full-bleed, behind content" }),
      anchor: opt(f.str(), { doc: "in-page nav target" }),
    },
  },

  {
    type: "Overlay",
    kind: "structural",
    doc: "Children stack in child order, each positioned by its own place.anchor. z-index is never exposed as a layout mechanism.",
    fields: {
      clip: opt(f.bool(), { doc: "default false" }),
    },
  },

  {
    type: "Carousel",
    kind: "structural",
    doc: "Controls are renderer chrome and are NEVER nodes in the tree (S10).",
    fields: {
      slidesPerView: req(f.union(f.num(), f.enum("auto")), { resp: true }),
      gap: opt(f.val(), { resp: true }),
      peek: opt(f.val(), { resp: true }),
      snap: req(f.enum("start", "center", "none")),
      loop: req(f.bool()),
      autoplay: req(f.union(f.val("duration"), f.literals(false)), {
        doc: "duration token / Raw ms, or false",
      }),
      controls: req(f.arr(f.enum("arrows", "dots", "progress", "counter"))),
      controlsPlacement: req(f.enum("edge", "overlay", "below-start", "below-center", "below-end")),
    },
  },

  {
    type: "Repeater",
    kind: "structural",
    fragment: true,
    doc: "A FRAGMENT, not a container: it emits n children into its parent's layout and has no layout, space, size or surface props of its own. That is what lets Stack > Repeater and Carousel > Repeater both work without duplicating layout props.",
    fields: {
      over: req(f.str()),
      as: req(f.str()),
      limit: opt(f.num(true)),
      /**
       * `[start, end)` — a window on `over`, end exclusive.
       *
       * For the index-tiered grid, which is how editorial pages are actually
       * laid out: one source list of six articles drawn as a lead, then two
       * feature cards, then three briefs. Each tier is a different card, and
       * which tier an item lands in is decided by its POSITION in the list.
       *
       * `when` cannot say this. A predicate tests a field on the item, and
       * nothing on article #4 marks it as a brief — it is a brief because it
       * is fourth. Without `slice` the only way to draw the page is three
       * hand-maintained arrays, which puts an editor's ordering decision in
       * three places and guarantees they drift.
       *
       * Mutually exclusive with `limit` (S13): both cap the same list, and a
       * tree that says `slice: [3, 6], limit: 2` has two answers.
       */
      slice: opt(f.arr(f.num(true)), { doc: "[start, end) — end exclusive; not with `limit` (S13)" }),
      paginate: opt(
        f.obj({
          mode: req(f.enum("pages", "more", "infinite")),
          pageSize: req(f.num(true)),
          urlKey: opt(f.str()),
        }),
        { doc: "phase 2 — schema only" },
      ),
    },
  },

  {
    type: "Custom",
    kind: "structural",
    doc: "Opaque rendering, but binding refs inside still validate.",
    fields: {
      ref: req(f.semverRef(), { doc: "`name@1.2.3` (S11)" }),
      props: req(f.opaque()),
      fallbackHeight: opt(f.val(), { resp: true, doc: "SSR layout stability" }),
    },
  },
];
