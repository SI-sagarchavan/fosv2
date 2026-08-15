/**
 * The hybrid pipeline, end to end, on one real section.
 *
 *   IR ──▶ compile ──▶ repair ──▶ validate ──▶ conform ──▶ render ──▶ diff
 *          (rules)     (model)     (@dsl)      (@conform)  (@renderer)
 *
 * The shape of the argument this makes:
 *
 *   The COMPILER is deterministic and refuses to guess. Everything it emits is
 *   traceable to a node id in the frame.
 *
 *   The REPAIR pass answers only what the frame cannot: sources, bindings,
 *   intent. In production it is a model; here it is deterministic stand-ins so
 *   the run is reproducible (see repairs.mjs).
 *
 *   Both GATES run after the repair, not before. A repair that breaks the schema
 *   or drifts from the frame is caught here, which is the only reason it is safe
 *   to let a model near the tree at all.
 *
 * Usage:  node examples/news-section/pipeline.mjs [--open]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBindings, formatBindingReport } from "../_shared/binding-gate.mjs";
import { repair } from "./repairs.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const out = resolve(here, "out");
mkdirSync(out, { recursive: true });

const IR = resolve(here, "news.ir.json");
const DATA = resolve(here, "data.json");
const THEME = resolve(repo, "packages/tokens/fixtures/southern-brave.json");
const REFERENCE = resolve(here, "reference.png");

/** The frame the reference PNG was exported from — 1170x444, not the 1366 root. */
const ROOT_SRC = "1:4745";
const DESIGN_WIDTH = 1170;

const steps = [];

// ---------------------------------------------------------------------------
// 1. Compile — deterministic, no model
// ---------------------------------------------------------------------------

step("compile", () => {
  const log = run("packages/compile", [
    "build",
    "--ir", IR,
    "--theme", THEME,
    "--surfaces", resolve(repo, "packages/tokens/surfaces/southern-brave.json"),
    "--out", resolve(out, "1-compiled.dsl.json"),
    "--surfaces-out", resolve(out, "needed-surfaces.json"),
  ]);
  // The compiler reports the surfaces it needed that the theme has not authored.
  // Merging them is a design-ops task in real life; here it keeps the run whole.
  const base = JSON.parse(readFileSync(resolve(repo, "packages/tokens/surfaces/southern-brave.json"), "utf8"));
  const needed = JSON.parse(readFileSync(resolve(out, "needed-surfaces.json"), "utf8"));
  Object.assign(base.surfaces, needed.surfaces);
  writeFileSync(resolve(out, "surfaces.json"), JSON.stringify(base, null, 2));
  return log.trim().split("\n").slice(0, 3).join("\n");
});

// ---------------------------------------------------------------------------
// 2. Repair — the model's half
// ---------------------------------------------------------------------------

let edits = [];
step("repair", () => {
  const compiled = JSON.parse(readFileSync(resolve(out, "1-compiled.dsl.json"), "utf8"));
  const ir = JSON.parse(readFileSync(IR, "utf8"));
  const result = repair(compiled, ir);
  edits = result.edits;
  writeFileSync(resolve(out, "2-repaired.dsl.json"), JSON.stringify(result.tree, null, 2));
  writeFileSync(resolve(out, "repairs.json"), JSON.stringify(edits, null, 2));

  const byRule = new Map();
  for (const e of edits) byRule.set(e.ruleId, (byRule.get(e.ruleId) ?? 0) + 1);
  return [...byRule].map(([rule, n]) => `  ${String(n).padStart(3)} × ${rule}`).join("\n");
});

// ---------------------------------------------------------------------------
// 3. Gates — schema, then fidelity. Both AFTER the repair.
// ---------------------------------------------------------------------------

step("validate (@fanos/dsl)", () =>
  run("packages/dsl", [
    "check",
    "--tree", resolve(out, "2-repaired.dsl.json"),
    "--theme", THEME,
    "--surfaces", resolve(out, "surfaces.json"),
  ]).trim().split("\n").slice(0, 4).join("\n"),
);

step("bindings resolve", () => {
  const tree = JSON.parse(readFileSync(resolve(out, "2-repaired.dsl.json"), "utf8"));
  const data = JSON.parse(readFileSync(DATA, "utf8"));
  const result = checkBindings(tree, data);
  if (!result.ok) throw new Error(formatBindingReport(result));
  return formatBindingReport(result);
});

step("conform (@fanos/conform)", () =>
  run("packages/conform", [
    "check",
    "--tree", resolve(out, "2-repaired.dsl.json"),
    "--ir", IR,
    "--theme", THEME,
    "--root-src", ROOT_SRC,
  ]).trim().split("\n").slice(0, 8).join("\n"),
);

// ---------------------------------------------------------------------------
// 4. Render and diff against the designer's own export
// ---------------------------------------------------------------------------

/**
 * The reference PNG is an export of ONE frame — 1:4745, 1170x444 — not the
 * 1366x538 page root the IR is rooted at. Rendering the root and diffing it
 * against a child compares two different pictures and calls the result a
 * failure. So the tree is re-rooted at the exported frame first.
 */
step("re-root at " + ROOT_SRC, () => {
  // BOTH trees, so the harness can put them side by side and the only thing
  // that differs between the tabs is the repairs themselves.
  const compiled = reRoot(JSON.parse(readFileSync(resolve(out, "1-compiled.dsl.json"), "utf8")));
  writeFileSync(resolve(out, "1b-compiled-section.dsl.json"), JSON.stringify(compiled.tree, null, 2));

  const repaired = reRoot(JSON.parse(readFileSync(resolve(out, "2-repaired.dsl.json"), "utf8")));
  writeFileSync(resolve(out, "2b-section.dsl.json"), JSON.stringify(repaired.tree, null, 2));

  return `${repaired.kept} of ${repaired.total} nodes kept, compiled and repaired`;
});

function reRoot(tree) {
  const target = tree.nodes.find((node) => node.src === ROOT_SRC);
  if (!target) throw new Error(`no node with src ${ROOT_SRC}`);

  const keep = new Set([target.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of tree.nodes) {
      if (!keep.has(node.id) && node.parent && keep.has(node.parent)) {
        keep.add(node.id);
        grew = true;
      }
    }
  }

  const nodes = tree.nodes
    .filter((node) => keep.has(node.id))
    .map((node) =>
      node.id === target.id
        ? { ...node, parent: null, idx: 0, props: stripPageSizing(node.props) }
        : node,
    );
  return { tree: { ...tree, nodes }, kept: nodes.length, total: tree.nodes.length };
}

/**
 * A section root is not positioned by a page it no longer has.
 *
 * The compiler gave this node `place` because inside the 1366 page root it was
 * absolutely positioned. Re-rooted, that anchors it to nothing and the renderer
 * reports the element as never becoming visible. Its fixed width goes too — a
 * section fills what it is given.
 */
function stripPageSizing(props) {
  const next = { ...props };
  delete next.place;
  if (next.size && typeof next.size === "object") next.size = { ...next.size, w: "full", h: "auto" };
  return next;
}

step("render", () =>
  run("packages/renderer", [
    "png",
    "--tree", resolve(out, "2b-section.dsl.json"),
    "--data", DATA,
    "--theme", THEME,
    "--surfaces", resolve(out, "surfaces.json"),
    "--out", resolve(out, "3-render.png"),
    "--width", String(DESIGN_WIDTH),
    "--design-width", String(DESIGN_WIDTH),
  ]).trim(),
);

step("diff vs reference.png", () =>
  run("packages/renderer", [
    "report",
    "--tree", resolve(out, "2b-section.dsl.json"),
    "--data", DATA,
    "--theme", THEME,
    "--surfaces", resolve(out, "surfaces.json"),
    "--expected", REFERENCE,
    "--width", String(DESIGN_WIDTH),
  ]).trim().split("\n").slice(0, 10).join("\n"),
);

// ---------------------------------------------------------------------------

console.log("\n" + "=".repeat(72));
for (const { name, ok, detail } of steps) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(detail.split("\n").map((l) => "      " + l).join("\n"));
}
console.log("=".repeat(72));
console.log(`${edits.length} repairs applied · artifacts in examples/news-section/out/`);
process.exit(steps.every((s) => s.ok) ? 0 : 1);

function step(name, fn) {
  process.stdout.write(`▸ ${name}\n`);
  try {
    steps.push({ name, ok: true, detail: fn() ?? "" });
  } catch (err) {
    steps.push({ name, ok: false, detail: String(err.stdout ?? err.message ?? err).slice(0, 1200) });
  }
}

function run(pkg, args) {
  return execFileSync("node", [resolve(repo, pkg, "dist/bin.js"), ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    cwd: resolve(repo, pkg),
  });
}
