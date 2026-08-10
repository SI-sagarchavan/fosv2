/**
 * Dot-path data interpolation for Text.content / Image.src / Image.alt.
 *
 * Phase 1 is static-fidelity, but the diff needs real values.
 * No expressions, no eval — only `{path.to.value}` substitution.
 *
 * Unresolved paths render the literal token and emit a warning — never
 * the string "undefined".
 */

export type DataBag = Record<string, unknown>;

const TOKEN_RE = /\{([A-Za-z_][A-Za-z0-9_.]*)\}/g;

export interface InterpolateResult {
  value: string;
  unresolved: string[];
}

/**
 * Replace every `{path}` in `template` with the value at that path in `data`.
 * Newlines and other characters in resolved values are preserved.
 */
export function interpolate(template: string, data: DataBag | undefined | null): InterpolateResult {
  if (!template.includes("{")) return { value: template, unresolved: [] };
  const unresolved: string[] = [];
  const value = template.replace(TOKEN_RE, (match, path: string) => {
    const hit = lookup(data, path);
    if (hit === undefined) {
      unresolved.push(path);
      return match; // keep literal `{path}`
    }
    return String(hit);
  });
  return { value, unresolved };
}

/** Dot-path lookup. Arrays are not indexed; only object keys. */
export function lookup(data: unknown, path: string): unknown {
  if (data === null || data === undefined) return undefined;
  const parts = path.split(".");
  let cur: unknown = data;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Log unresolved paths once per call site. Pure-friendly: returns warnings. */
export function formatUnresolvedWarnings(nodeId: string, prop: string, paths: string[]): string[] {
  return paths.map(
    (p) => `[fos-render] unresolved data path "{${p}}" on ${nodeId}.${prop} — left as literal`,
  );
}
