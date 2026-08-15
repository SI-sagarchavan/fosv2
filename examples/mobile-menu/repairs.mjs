/**
 * Repairs for the mobile menu drawer — the first MOBILE frame through the
 * pipeline (375x667, so `inferBreakpoint` selects the theme's mobile type set
 * rather than desktop).
 *
 * A menu is not a gallery, so the shared gallery rules do not apply: there is no
 * repeating image-plus-caption card. What repeats here is a LINK ROW — a label,
 * an optional trailing icon, and a hairline rule under it. So the binding rule
 * looks for text rows inside a vertical stack of alternating rows and rules, and
 * indexes them.
 *
 * The rules a menu needs that a page does not:
 *
 *   NAV LABELS ARE A LIST, not page copy. "NEWS" is `menu.primary.0.label`, and
 *   the eleventh item a designer adds should bind without a code change.
 *
 *   HAIRLINES ARE DIVIDERS, not zero-height vectors. The IR reports each rule as
 *   a VECTOR of height 0, which the compiler turns into an unnamed Icon. It is a
 *   Divider, and the DSL has one.
 */

/** Vertical stacks whose text rows are a navigation list, and where they bind. */
const LISTS = [
  { container: "menu_links", path: "menu.primary" },
  { container: "frame_427320270", path: "menu.secondary" },
];

export function repair(tree, ir) {
  const nodes = tree.nodes.map((node) => ({ ...node, props: { ...node.props } }));
  const index = buildIndex(nodes);
  const irIndex = indexIr(ir.root);
  const edits = [];
  const state = { nodes, index, irIndex, edits };
  for (const rule of RULES) rule.apply(state);
  return { tree: { ...tree, nodes: state.nodes }, edits };
}

const RULES = [
  {
    id: "icon-name",
    intent: "Map Figma layer names onto the renderer's icon registry.",
    apply({ nodes, edits }) {
      for (const node of nodes) {
        if (node.type !== "Icon") continue;
        const raw = String(node.props.name ?? "");
        const mapped = raw.replace(/^atom_icon_/, "").replace(/^icon_/, "");
        if (mapped === raw || mapped === "unknown") continue;
        edits.push(edit(node, "icon-name", `name: "${raw}" -> "${mapped}"`, "registry keys are unprefixed"));
        node.props.name = mapped;
      }
    },
  },

  {
    id: "hairline-to-divider",
    intent:
      "This is a zero-height vector between two rows. It is a rule, and the DSL has a Divider — say so instead of leaving an unnamed icon.",
    apply({ nodes, irIndex, edits }) {
      for (const node of nodes) {
        if (node.type !== "Icon" || node.props.name !== "unknown") continue;
        const source = irIndex.get(node.src);
        if (!source || source.type !== "VECTOR") continue;
        if (source.geometry.bbox.h > 1) continue;
        edits.push(
          edit(node, "hairline-to-divider", "Icon(unknown) -> Divider", `IR vector is ${source.geometry.bbox.w.toFixed(0)}x0 — a rule, not a glyph`),
        );
        node.type = "Divider";
        node.props = { size: { w: "full" } };
      }
    },
  },

  {
    id: "nav-bindings",
    intent:
      "These rows are a navigation list. Bind each label to its index so an added item needs no code change.",
    apply(state) {
      for (const { container, path } of LISTS) {
        const host = state.nodes.find((node) => node.id === container);
        if (!host) continue;
        const rows = (state.index.children.get(host.id) ?? []).filter(
          (row) => descendants(state.index, row.id).some((child) => child.type === "Text"),
        );
        rows.forEach((row, position) => {
          const label = descendants(state.index, row.id).find((child) => child.type === "Text");
          if (!label) return;
          const binding = `{${path}.${position}.label}`;
          state.edits.push(
            edit(label, "nav-bindings", `content -> "${binding}"`, `row ${position + 1} of ${rows.length} in ${container}`),
          );
          label.props.content = binding;
        });
      }
    },
  },

  {
    id: "image-fit",
    intent: "Express a Figma crop as intent — fill the frame and cover it.",
    apply({ nodes, index, edits }) {
      for (const node of nodes) {
        if (node.type !== "Image") continue;
        if (!node.props.src) {
          edits.push(edit(node, "image-fit", `src -> "{menu.backdrop}"`, "the drawer's squad photo"));
          node.props.src = "{menu.backdrop}";
          node.props.alt = "";
        }
        const place = node.props.place;
        if (!place || place.anchor === "fill") continue;
        const parent = index.byId.get(node.parent);
        if (!parent || parent.type !== "Overlay") continue;
        edits.push(edit(node, "image-fit", `place -> "fill"`, "an absolute crop is brittle at other widths"));
        node.props.place = { anchor: "fill" };
        node.props.fit = "cover";
        delete node.props.size;
      }
    },
  },
];

function edit(node, ruleId, change, reason) {
  return { ruleId, nodeId: node.id, nodeType: node.type, src: node.src, change, reason };
}
function buildIndex(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map();
  for (const n of nodes) {
    const b = children.get(n.parent) ?? [];
    b.push(n);
    children.set(n.parent, b);
  }
  for (const b of children.values()) b.sort((a, z) => a.idx - z.idx);
  return { byId, children };
}
function descendants(index, rootId) {
  const out = [];
  const stack = [...(index.children.get(rootId) ?? [])];
  while (stack.length > 0) {
    const n = stack.shift();
    out.push(n);
    stack.unshift(...(index.children.get(n.id) ?? []));
  }
  return out;
}
function indexIr(root) {
  const map = new Map();
  const stack = [root];
  while (stack.length > 0) {
    const n = stack.pop();
    map.set(n.id, n);
    for (const c of n.children) stack.push(c);
  }
  return map;
}
