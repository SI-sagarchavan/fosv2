/**
 * Repairs for any GALLERY PAGE — a listing of cards, each an image with a
 * caption and a date, under a hero and above a footer.
 *
 * Written for the Photos page, then pointed at the News page with no changes,
 * which was the test that mattered: these rules find their targets
 * STRUCTURALLY rather than by name. "The smallest container holding exactly one
 * unsourced image and some text" is a photo card whatever the designer called
 * the frame — and there are six different frame names across ten cards on the
 * Photos page alone.
 *
 * Naming every node, as the two section examples do, does not survive scale: ten
 * cards would be ten copies of one rule, and an eleventh card would be invisible
 * to all of them. A model reaches for the same generalisation.
 *
 * All a page supplies is where its content lives.
 */

/**
 * @param options.dataRoot  the data key the cards bind under, e.g. `photos`
 * @param options.chrome    literal page copy -> binding, e.g. Photos -> title
 */
export function galleryRepairs(options) {
  return { repair: (tree, ir) => repair(tree, ir, options) };
}

function repair(tree, ir, options) {
  const nodes = tree.nodes.map((node) => ({ ...node, props: { ...node.props } }));
  const index = buildIndex(nodes);
  const irIndex = indexIr(ir.root);
  const edits = [];
  const state = { nodes, index, irIndex, edits, options };

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
    id: "photo-card-bindings",
    intent:
      "These cards are one repeating unit rendered ten times. Bind each card's image, title and date to its index in the gallery data.",
    apply(state) {
      const cards = findPhotoCards(state);
      cards.forEach((card, position) => {
        const path = `${state.options.dataRoot}.items.${position}`;

        const image = descendants(state.index, card.id).find(
          (node) => node.type === "Image" && !node.props.src,
        );
        if (image) {
          state.edits.push(
            edit(image, "photo-card-bindings", `src -> "{${path}.image}"`, `card ${position + 1} of ${cards.length}`),
          );
          image.props.src = `{${path}.image}`;
          image.props.alt = `{${path}.title}`;
        }

        // Longest text is the caption, the short one that parses as a date is
        // the date. Position alone is unreliable — the badge count sits between
        // them on some cards and not others.
        const texts = descendants(state.index, card.id).filter((node) => node.type === "Text");
        const dated = texts.filter((node) => isDate(String(node.props.content ?? "")));
        const captions = texts.filter((node) => !isDate(String(node.props.content ?? "")) && !isCount(String(node.props.content ?? "")));
        const caption = captions.sort((a, b) => String(b.props.content).length - String(a.props.content).length)[0];

        if (caption) {
          state.edits.push(edit(caption, "photo-card-bindings", `content -> "{${path}.title}"`, "the caption"));
          caption.props.content = `{${path}.title}`;
        }
        for (const node of dated) {
          state.edits.push(edit(node, "photo-card-bindings", `content -> "{${path}.date}"`, "parses as a date"));
          node.props.content = `{${path}.date}`;
        }
        for (const node of texts) {
          if (!isCount(String(node.props.content ?? ""))) continue;
          state.edits.push(edit(node, "photo-card-bindings", `content -> "{${path}.count}"`, "the photo-count badge"));
          node.props.content = `{${path}.count}`;
        }
      });
    },
  },

  {
    id: "image-fit",
    intent: "Express a Figma crop as intent — fill the frame and cover it.",
    apply({ nodes, index, edits }) {
      for (const node of nodes) {
        if (node.type !== "Image") continue;
        const place = node.props.place;
        if (!place || place.anchor === "fill") continue;
        const parent = index.byId.get(node.parent);
        if (!parent || parent.type !== "Overlay" || parent.props.clip !== true) continue;
        edits.push(edit(node, "image-fit", `place -> "fill"; size dropped`, "an absolute crop is brittle at every other width"));
        node.props.place = { anchor: "fill" };
        node.props.fit = "cover";
        delete node.props.size;
      }
    },
  },

  {
    id: "page-chrome",
    intent: "Bind the page's own copy — breadcrumb, title, calls to action.",
    apply({ nodes, edits, options }) {
      const bindings = new Map(Object.entries(options.chrome));
      for (const node of nodes) {
        if (node.type !== "Text") continue;
        const binding = bindings.get(String(node.props.content ?? "").trim());
        if (!binding) continue;
        edits.push(edit(node, "page-chrome", `content -> "${binding}"`, "page-level copy"));
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

/**
 * A photo card: the smallest container holding exactly one unsourced Image and
 * at least one Text. Found structurally rather than by name, because the ten
 * cards carry six different Figma frame names between them.
 */
function findPhotoCards(state) {
  const cards = [];
  for (const node of state.nodes) {
    const inside = descendants(state.index, node.id);
    const images = inside.filter((child) => child.type === "Image" && !child.props.src);
    const texts = inside.filter((child) => child.type === "Text");
    if (images.length !== 1 || texts.length === 0) continue;
    // Smallest such container only — an ancestor holding one card also matches.
    if (inside.some((child) => isCard(state, child))) continue;
    cards.push(node);
  }
  return cards;
}

function isCard(state, node) {
  const inside = descendants(state.index, node.id);
  const images = inside.filter((child) => child.type === "Image" && !child.props.src);
  const texts = inside.filter((child) => child.type === "Text");
  return images.length === 1 && texts.length > 0;
}

const DATE_RE = /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/;
function isDate(value) {
  return DATE_RE.test(value.trim());
}
function isCount(value) {
  return /^\d{1,3}$/.test(value.trim());
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
