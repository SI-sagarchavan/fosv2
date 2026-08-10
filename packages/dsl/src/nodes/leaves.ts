/**
 * Part 5 — Leaves (10).
 */

import { f, opt, req } from "../field.js";
import type { NodeSpec } from "./structural.js";

export const LEAF_NODES: NodeSpec[] = [
  {
    type: "Text",
    kind: "leaf",
    doc: "Orientation is named semantically, not after CSS writing-mode. The agent should not need to know `sideways-lr` exists, and native does not have it.",
    fields: {
      content: req(f.str()),
      // NOT Resp<>. @fanos/tokens already resolves type.* per breakpoint, so a
      // style ref is responsive on its own — see T3.
      style: req(f.token("type")),
      tone: opt(f.token("color")),
      align: opt(f.enum("start", "center", "end"), { resp: true }),
      truncate: opt(f.num(true), { doc: "max lines" }),
      orientation: opt(f.enum("horizontal", "vertical-up", "vertical-down")),
      /**
       * Figma's per-text-node case setting. It is a PRESENTATION choice, not
       * content: the design file stores "Ben\nMcKinney" and displays
       * "BEN MCKINNEY". Without this the only way to reproduce the design is to
       * uppercase the data, which corrupts the value for every other consumer.
       */
      textCase: opt(f.enum("none", "upper", "lower", "title")),
      as: opt(f.enum("h1", "h2", "h3", "h4", "h5", "h6", "p", "span")),
    },
  },

  {
    type: "RichText",
    kind: "leaf",
    doc: "Authored markup. `prose` styles the body copy inside it.",
    fields: {
      content: req(f.str()),
      style: req(f.token("type")),
      prose: opt(f.token("type")),
    },
  },

  {
    type: "Image",
    kind: "leaf",
    doc: "`placeholder` is an asset token rather than a free URL — an untracked URL is exactly the hand-maintained value this package exists to prevent.",
    fields: {
      src: req(f.str(), { doc: "image URL or binding — NOT the Figma node id" }),
      alt: req(f.str()),
      fit: req(f.enum("cover", "contain", "fill", "none")),
      position: opt(f.anchor()),
      ratio: opt(f.ratio()),
      scrim: opt(f.token("gradient"), { doc: "readability wash over the image" }),
      placeholder: opt(f.token("asset")),
      priority: opt(f.bool(), { doc: "eager-load above the fold" }),
    },
  },

  {
    type: "Icon",
    kind: "leaf",
    doc: "Named glyph from the icon set.",
    fields: {
      name: req(f.str()),
      size: opt(f.val()),
      tone: opt(f.token("color")),
    },
  },

  {
    type: "Button",
    kind: "leaf",
    doc: "`styleN` matches the `button_<variant>_style_N` token families.",
    fields: {
      label: req(f.str()),
      variant: req(f.enum("filled", "outline", "link", "no-padding")),
      styleN: req(f.literals(1, 2, 3)),
      size: req(f.enum("sm", "md", "lg")),
      iconStart: opt(f.str()),
      iconEnd: opt(f.str()),
      action: req(f.action()),
      loading: opt(f.bool()),
      disabled: opt(f.bool()),
    },
  },

  {
    type: "Link",
    kind: "leaf",
    doc: "Navigation that is not a button.",
    fields: {
      label: req(f.str()),
      href: req(f.str()),
      variant: opt(f.enum("inline", "standalone", "quiet")),
      iconEnd: opt(f.str()),
      external: opt(f.bool()),
    },
  },

  {
    type: "Tag",
    kind: "leaf",
    doc: "One Tag, not Badge + Chip. LIVE/RECENT and WOMEN/MEN are the same thing with different tones; two node types would be an encoding coin-flip for the agent.",
    fields: {
      label: req(f.str()),
      variant: req(f.enum("solid", "outline", "soft")),
      tone: req(f.token("color")),
      size: opt(f.enum("sm", "md", "lg")),
    },
  },

  {
    type: "Divider",
    kind: "leaf",
    doc: "A rule between things.",
    fields: {
      orientation: req(f.enum("horizontal", "vertical")),
      tone: opt(f.token("color")),
      opacity: opt(f.token("opacity")),
      inset: opt(f.val()),
    },
  },

  {
    type: "Countdown",
    kind: "leaf",
    doc: "Counts down to an instant.",
    fields: {
      to: req(f.str(), { doc: "ISO-8601 instant or binding" }),
      units: req(f.arr(f.enum("d", "h", "m", "s"))),
      labels: opt(f.bool()),
      onZero: opt(f.enum("hide", "hold")),
    },
  },

  {
    type: "Tabs",
    kind: "leaf",
    doc: "A leaf, not a container. It renders toggle chrome and writes state; the panels it switches are elsewhere in the tree.",
    fields: {
      bind: req(f.str(), { doc: "state key this control writes" }),
      options: req(
        f.union(f.arr(f.obj({ value: req(f.str()), label: req(f.str()) })), f.str()),
        { doc: "literal options, or a binding that yields them" },
      ),
      variant: opt(f.enum("underline", "pill", "segmented")),
    },
  },
];
