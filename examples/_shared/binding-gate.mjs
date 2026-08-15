/**
 * The gate that was missing.
 *
 * This exists because of a bug found while building this sample, and the way it
 * was found is the point.
 *
 * The repair pass bound text to `{section.features[0].headline}`. The renderer's
 * resolver only understands dot paths — it splits on "." and indexes straight
 * into the value — so `features[0]` reaches nothing while `features.0` reaches
 * the array element. The wrong one renders as the literal string
 * "{section.features[0].headline}" on the page.
 *
 * BOTH EXISTING GATES PASSED IT.
 *
 *   @fanos/dsl      sees a string in a string field. Legal.
 *   @fanos/conform  compares geometry and paint against the frame. Unaffected.
 *
 * So a model could invent any data path it liked and the only symptom would be
 * braces rendered on a shipped page. A pipeline that lets a model write bindings
 * needs a gate that checks the bindings, and neither existing package is the
 * wrong place for it — this belongs in @fanos/dsl as a validation with the data
 * document passed in, alongside T1's token checks. It lives here for now because
 * moving it is an API change to a package with 156 tests.
 *
 * The rule: every `{path}` in the tree resolves against the data document.
 */

/** Mirrors the renderer's own matcher — deliberately, so this gate cannot be laxer. */
const TOKEN_RE = /\{([A-Za-z_][A-Za-z0-9_.]*)\}/g;

/**
 * Anything with braces that the matcher above does NOT accept. A binding the
 * renderer will silently print rather than resolve — the exact failure this gate
 * exists to catch.
 */
const SUSPICIOUS_RE = /\{[^}]*[^A-Za-z0-9_.{}][^}]*\}/g;

export function checkBindings(tree, data) {
  const unresolved = [];
  const malformed = [];
  let checked = 0;

  for (const node of tree.nodes) {
    for (const [prop, value] of Object.entries(node.props ?? {})) {
      if (typeof value !== "string" || !value.includes("{")) continue;

      for (const match of value.matchAll(SUSPICIOUS_RE)) {
        malformed.push({ nodeId: node.id, prop, text: match[0] });
      }
      for (const match of value.matchAll(TOKEN_RE)) {
        checked++;
        if (resolve(data, match[1]) === undefined) {
          unresolved.push({ nodeId: node.id, prop, path: match[1] });
        }
      }
    }
  }

  return { checked, unresolved, malformed, ok: unresolved.length === 0 && malformed.length === 0 };
}

function resolve(data, path) {
  let current = data;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

export function formatBindingReport(result) {
  if (result.ok) return `${result.checked} bindings, all resolve`;
  const lines = [`${result.checked} bindings — ${result.unresolved.length + result.malformed.length} broken`];
  for (const item of result.malformed.slice(0, 5)) {
    lines.push(`  malformed  ${item.nodeId}.${item.prop}  ${item.text}  (renders as literal text)`);
  }
  for (const item of result.unresolved.slice(0, 5)) {
    lines.push(`  unresolved ${item.nodeId}.${item.prop}  {${item.path}}  (no such path in the data)`);
  }
  return lines.join("\n");
}
