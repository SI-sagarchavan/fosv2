/**
 * The repair pass — what a model does after the deterministic compiler.
 *
 * The compiler transcribes: it turns Figma geometry into a legal DSL tree and
 * refuses to guess. That leaves a specific, enumerable set of gaps, because a
 * Figma frame simply does not contain the answers:
 *
 *   an image has no URL          Figma holds pixels, not sources
 *   text is a literal string     a design shows one article, a page renders many
 *   a crop is absolute geometry  the intent is "cover this box", not "455px at -21"
 *   an icon carries a layer name a renderer has its own registry
 *   a clamp is a rendered height "lines: 3" is a measurement, not an instruction
 *
 * Every one of those is a semantic judgement, which is exactly the shape of task
 * a model is good at and a compiler must not attempt.
 *
 * IN PRODUCTION each repair below is a prompt: the model sees the node, its IR
 * source, the available data paths, and the rule it is being asked to satisfy.
 * HERE they are deterministic stand-ins, so the sample is reproducible — but the
 * harness around them is the real one. Each repair states the intent it is
 * standing in for, produces an auditable edit with a reason, and is then put
 * through the same two gates a model's output would be:
 *
 *   1. does the tree still validate      (@fanos/dsl)
 *   2. is it still true to the frame     (@fanos/conform)
 *
 * That is the point of the exercise. The value is not in the cleverness of the
 * repair, it is in the fact that nothing reaches a renderer without both gates
 * agreeing — so a wrong repair is caught rather than shipped.
 */

/** @typedef {{ id: string, parent: string|null, idx: number, type: string, src: string, props: Record<string, unknown> }} DslNode */

/**
 * Which data path a card's content belongs to.
 *
 * Derived from the column the node sits in, which the compiler preserved from
 * the designer's own frame names — "Leading Column", "Middle Column",
 * "Trailing Column". A model would infer the same mapping from those names plus
 * the shape of the data; hardcoding the inference keeps the sample reproducible.
 */
const COLUMN_BINDINGS = [
  { column: "leading_column", paths: ["section.lead"] },
  // Dot-separated indexes, NOT `features[0]`. The renderer's resolver splits on
  // "." and indexes straight into the value, so `features.0` reaches an array
  // element and `features[0]` reaches nothing — it renders as literal braces.
  // A model would make exactly this mistake; see the binding gate in
  // pipeline.mjs, which exists because neither the schema nor the fidelity
  // check catches it.
  { column: "middle_column", paths: ["section.features.0", "section.features.1"] },
  {
    column: "trailing_column",
    paths: ["section.briefs.0", "section.briefs.1", "section.briefs.2"],
  },
];

/** Text role within a card, by order of appearance. */
const CARD_TEXT_ROLES = ["headline", "summary", "date"];

export function repair(tree, ir, options = {}) {
  const nodes = tree.nodes.map((node) => ({ ...node, props: { ...node.props } }));
  const index = buildIndex(nodes);
  const irIndex = indexIr(ir.root);
  const edits = [];

  for (const rule of RULES) {
    rule.apply({ nodes, index, irIndex, edits, options });
  }

  return { tree: { ...tree, nodes }, edits };
}

// ---------------------------------------------------------------------------
// The repairs
// ---------------------------------------------------------------------------

const RULES = [
  {
    id: "icon-name",
    intent:
      "This Icon's name is the Figma layer name. Map it to a name in the renderer's icon registry, or say you cannot.",
    apply({ nodes, edits }) {
      for (const node of nodes) {
        if (node.type !== "Icon") continue;
        const raw = String(node.props.name ?? "");
        const mapped = raw.replace(/^atom_icon_/, "").replace(/^icon_/, "");
        if (mapped === raw) continue;
        edits.push(
          edit(node, "icon-name", `name: "${raw}" -> "${mapped}"`, "the renderer's registry keys are unprefixed"),
        );
        node.props.name = mapped;
      }
    },
  },

  {
    id: "image-source",
    intent:
      "This Image has no src — Figma holds pixels, not URLs. Bind it to the data path for the card it sits in.",
    apply({ nodes, index, edits }) {
      for (const { column, paths } of COLUMN_BINDINGS) {
        const images = descendants(index, column).filter((node) => node.type === "Image");
        images.forEach((node, position) => {
          const path = paths[Math.min(position, paths.length - 1)];
          if (node.props.src) return;
          const binding = `{${path}.image}`;
          edits.push(
            edit(node, "image-source", `src: "" -> "${binding}"`, `${position + 1} of ${images.length} in ${column}`),
          );
          node.props.src = binding;
          node.props.alt = `{${path}.headline}`;
        });
      }
    },
  },

  {
    id: "image-fit",
    intent:
      "This Image is placed with the absolute geometry of a Figma crop. Express the intent instead: fill the frame and cover it.",
    apply({ nodes, index, edits }) {
      for (const node of nodes) {
        if (node.type !== "Image") continue;
        const place = node.props.place;
        if (!place || place.anchor === "fill") continue;
        const parent = index.byId.get(node.parent);
        // Only inside a clipping Overlay: elsewhere the offset may be real
        // composition rather than a crop.
        if (!parent || parent.type !== "Overlay" || parent.props.clip !== true) continue;

        edits.push(
          edit(
            node,
            "image-fit",
            `place: ${JSON.stringify(place.anchor)}+offset -> "fill"; size dropped`,
            "a crop transcribed as 455x369 at -21px is brittle at every other width",
          ),
        );
        node.props.place = { anchor: "fill" };
        node.props.fit = "cover";
        delete node.props.size;
      }
    },
  },

  {
    id: "text-truncate",
    intent:
      "The IR measured this text at N rendered lines with height-autoresize. If the design clamps it, say so with `truncate`.",
    apply({ nodes, irIndex, edits }) {
      for (const node of nodes) {
        if (node.type !== "Text") continue;
        const source = irIndex.get(node.src);
        const text = source?.text;
        if (!text || text.autoResize !== "HEIGHT") continue;
        // WIDTH_AND_HEIGHT hugs its content — it is never clamped. HEIGHT means
        // a fixed width and a measured number of lines, which is a clamp.
        if (!(text.lines > 0)) continue;
        edits.push(
          edit(node, "text-truncate", `truncate: ${text.lines}`, `IR measured ${text.lines} lines at a fixed width`),
        );
        node.props.truncate = text.lines;
      }
    },
  },

  {
    id: "text-binding",
    intent:
      "This Text holds one article's literal copy. Bind it to the data path for its card and role, so the section renders any article.",
    apply({ nodes, index, edits }) {
      for (const { column, paths } of COLUMN_BINDINGS) {
        const cards = cardsOf(index, column, paths.length);
        cards.forEach((card, position) => {
          const path = paths[Math.min(position, paths.length - 1)];
          const texts = descendants(index, card.id).filter((node) => node.type === "Text");
          texts.forEach((node, order) => {
            const role = CARD_TEXT_ROLES[order];
            if (!role) return;
            const binding = `{${path}.${role}}`;
            edits.push(
              edit(node, "text-binding", `content -> "${binding}"`, `${role} of ${path}`),
            );
            node.props.content = binding;
          });
        });
      }
    },
  },

  {
    id: "section-chrome",
    intent: "The section title and its call to action are content too. Bind them.",
    apply({ nodes, edits }) {
      const bindings = {
        "SOUTH COAST STORIES": "{section.title}",
        "VIEW MORE": "{section.cta}",
      };
      for (const node of nodes) {
        if (node.type !== "Text") continue;
        const binding = bindings[String(node.props.content ?? "")];
        if (!binding) continue;
        edits.push(edit(node, "section-chrome", `content -> "${binding}"`, "section-level copy"));
        node.props.content = binding;
      }
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** A column's cards: its direct children, or the column itself when it IS one. */
function cardsOf(index, columnId, expected) {
  const direct = index.children.get(columnId) ?? [];
  if (expected === 1) return [index.byId.get(columnId)].filter(Boolean);
  return direct;
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
