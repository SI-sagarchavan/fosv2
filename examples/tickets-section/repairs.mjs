/**
 * Repairs for the Tickets hero.
 *
 * A different frame exercises different gaps, and this one has two the news
 * section never hit:
 *
 *   A WORDMARK ARRIVES AS 14 VECTOR PATHS. The compiler transcribed them as 14
 *   `Icon name: "unknown"`, which is exactly right and exactly useless — it
 *   cannot know that those outlines spell "SOUTHERN BRAVE" and that the design
 *   system already has that logo as an asset. Recognising a wordmark is a
 *   semantic judgement about brand, which is the model's half of the job.
 *
 *   A COMPOSED PLATE ARRIVES AS THREE OVERLAPPING IMAGES. A stadium photo and
 *   two ink-splatter masks, each cropped and positioned to a fraction of a
 *   pixel. As a composition it is one picture; as three absolutely-placed
 *   layers it is three things to keep in sync at every breakpoint.
 *
 * Both collapse many nodes into one, which is the first thing in this pipeline
 * that trades fidelity for sense — so both are reported honestly, and the
 * conform gate is left to have its say rather than being worked around.
 */

const HEADING = "THE BOWL IS CALLING";

export function repair(tree, ir) {
  const nodes = tree.nodes.map((node) => ({ ...node, props: { ...node.props } }));
  const index = buildIndex(nodes);
  const irIndex = indexIr(ir.root);
  const edits = [];
  const state = { nodes, index, irIndex, edits };

  for (const rule of RULES) rule.apply(state);

  // Rules may drop nodes; rebuild the list from what survived, preserving order.
  const alive = new Set(state.nodes.map((node) => node.id));
  const kept = state.nodes.filter((node) => node.parent === null || alive.has(node.parent));
  return { tree: { ...tree, nodes: kept }, edits };
}

const RULES = [
  {
    id: "wordmark-to-asset",
    intent:
      "These sibling vector paths form a wordmark. If the design system has it as an asset, replace the whole group with one Image; otherwise leave them alone.",
    apply(state) {
      // The logo group: an Overlay whose descendants are ALL unnamed icons.
      for (const node of [...state.nodes]) {
        // The snapshot is taken before any conversion, so a nested group that an
        // outer conversion already absorbed is still in it. Converting that too
        // produces a second logo and strands an icon.
        if (!state.nodes.includes(node)) continue;
        if (node.type !== "Overlay") continue;
        const inside = descendants(state.index, node.id);
        if (inside.length < 4) continue;
        // Intermediate groups are part of a wordmark too — a logo is nested
        // groups of letterforms. Requiring every descendant to be an Icon
        // matched the two inner letter-groups and left the largest path
        // stranded outside them.
        if (!inside.some((child) => child.type === "Icon")) continue;
        if (!inside.every((child) => child.type === "Overlay" || (child.type === "Icon" && child.props.name === "unknown"))) continue;
        // Only the outermost such group — skip if an ancestor already qualifies.
        if (ancestors(state.index, node).some((a) => isWordmarkGroup(state.index, a))) continue;

        state.edits.push(
          edit(node, "wordmark-to-asset", `${inside.length} unnamed vector icons -> 1 Image`, "the Southern Brave wordmark is an authored asset, not 14 paths"),
        );

        for (const child of inside) drop(state, child.id);
        node.type = "Image";
        node.props = {
          ...node.props,
          src: "{tickets.wordmark}",
          alt: "Southern Brave",
          fit: "contain",
        };
      }
    },
  },

  {
    id: "plate-to-asset",
    intent:
      "These overlapping images are one composed background. Collapse them to a single plate bound to the exported asset.",
    apply(state) {
      for (const node of [...state.nodes]) {
        if (node.type !== "Overlay") continue;
        const inside = state.index.children.get(node.id) ?? [];
        if (inside.length < 2) continue;
        if (!inside.every((child) => child.type === "Image" && !child.props.src)) continue;

        // The CONTAINER becomes the image and every layer inside it is absorbed
        // into it — the same shape as the wordmark collapse. Keeping one sibling
        // and deleting the others instead leaves those others represented by
        // nothing, and conform is right to call that missing: absorption has to
        // have an absorber that contains them.
        state.edits.push(
          edit(node, "plate-to-asset", `${inside.length} image layers -> 1 Image on their container`, "a photo plus two ink masks is one picture, not three positioned crops"),
        );
        for (const child of inside) drop(state, child.id);

        node.type = "Image";
        node.props = {
          ...node.props,
          src: "{tickets.plate}",
          alt: "The Utilita Bowl",
          fit: "cover",
        };
        delete node.props.clip;
      }
    },
  },

  {
    id: "icon-name",
    intent: "Map a Figma layer name onto the renderer's icon registry.",
    apply({ nodes, edits }) {
      for (const node of nodes) {
        if (node.type !== "Icon") continue;
        const raw = String(node.props.name ?? "");
        const mapped = raw.replace(/^atom_icon_/, "").replace(/^icon_/, "");
        if (mapped === raw) continue;
        edits.push(edit(node, "icon-name", `name: "${raw}" -> "${mapped}"`, "registry keys are unprefixed"));
        node.props.name = mapped;
      }
    },
  },

  {
    id: "text-case",
    intent:
      "The export renders this label in capitals but the IR stores mixed case — Figma applies text-case visually and the IR does not carry it. Restore the intent.",
    apply({ nodes, edits }) {
      for (const node of nodes) {
        if (node.type !== "Text") continue;
        if (!String(node.props.style ?? "").startsWith("type.button")) continue;
        edits.push(
          edit(node, "text-case", `textCase: "upper"`, "IR 1.1.0 does not carry Figma's text-case; the reference export is capitals"),
        );
        node.props.textCase = "upper";
      }
    },
  },

  {
    id: "text-binding",
    intent: "Bind literal copy to the section's data.",
    apply({ nodes, edits }) {
      const bindings = new Map([
        [HEADING, "{tickets.heading}"],
        ["Get Tickets", "{tickets.cta}"],
      ]);
      for (const node of nodes) {
        if (node.type !== "Text") continue;
        const content = String(node.props.content ?? "");
        const binding =
          bindings.get(content) ?? (content.startsWith("Nothing beats") ? "{tickets.blurb}" : undefined);
        if (!binding) continue;
        edits.push(edit(node, "text-binding", `content -> "${binding}"`, "one hero, many campaigns"));
        node.props.content = binding;
      }
    },
  },

  {
    id: "text-truncate",
    intent: "The IR measured N rendered lines at a fixed width. If the design clamps, say so.",
    apply({ nodes, irIndex, edits }) {
      for (const node of nodes) {
        if (node.type !== "Text") continue;
        const text = irIndex.get(node.src)?.text;
        if (!text || text.autoResize !== "HEIGHT" || !(text.lines > 0)) continue;
        edits.push(edit(node, "text-truncate", `truncate: ${text.lines}`, `IR measured ${text.lines} lines`));
        node.props.truncate = text.lines;
      }
    },
  },
];

// ---------------------------------------------------------------------------

function isWordmarkGroup(index, node) {
  if (node.type !== "Overlay") return false;
  const inside = descendants(index, node.id);
  return (
    inside.length >= 4 &&
    inside.some((c) => c.type === "Icon") &&
    inside.every((c) => c.type === "Overlay" || (c.type === "Icon" && c.props.name === "unknown"))
  );
}

function drop(state, id) {
  state.nodes = state.nodes.filter((node) => node.id !== id);
  state.index = buildIndex(state.nodes);
}

function edit(node, ruleId, change, reason) {
  return { ruleId, nodeId: node.id, nodeType: node.type, src: node.src, change, reason };
}

function buildIndex(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map();
  for (const node of nodes) {
    const bucket = children.get(node.parent) ?? [];
    bucket.push(node);
    children.set(node.parent, bucket);
  }
  for (const bucket of children.values()) bucket.sort((a, b) => a.idx - b.idx);
  return { byId, children };
}

function descendants(index, rootId) {
  const out = [];
  const stack = [...(index.children.get(rootId) ?? [])];
  while (stack.length > 0) {
    const node = stack.shift();
    out.push(node);
    stack.unshift(...(index.children.get(node.id) ?? []));
  }
  return out;
}

function ancestors(index, node) {
  const out = [];
  let current = node.parent ? index.byId.get(node.parent) : undefined;
  while (current) {
    out.push(current);
    current = current.parent ? index.byId.get(current.parent) : undefined;
  }
  return out;
}

function indexIr(root) {
  const map = new Map();
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    map.set(node.id, node);
    for (const child of node.children) stack.push(child);
  }
  return map;
}
