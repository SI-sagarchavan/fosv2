/**
 * How a Figma variable name is looked up. PURE.
 *
 * Local variables keep a generous index: `spacing_4` finds `spacing_4`,
 * `Spacing/spacing_4`, `spacing 4`. Library catalog hits must be stricter —
 * squashing the whole path turns theme `spacing_1` (4px) into the same key as
 * a published `spacing/1` (1px), and Bind then tries to import the wrong
 * variable.
 */
export function leafKeys(name: string): string[] {
  const leaf = name.split("/").pop() ?? name;
  const lower = leaf.trim().toLowerCase();
  const squashed = squash(lower);
  return squashed === lower ? [lower] : unique([lower, squashed]);
}

export function nameKeys(name: string): string[] {
  const leaf = leafKeys(name);
  const full = squash(name.toLowerCase());
  return leaf.includes(full) ? leaf : unique([...leaf, full]);
}

function squash(value: string): string {
  return value.replace(/[\s_.\-/]+/g, "");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** True when a theme raw name and a Figma name should be treated as the same token. */
export function namesMatch(themeRaw: string, figmaName: string): boolean {
  const want = new Set(leafKeys(themeRaw));
  return leafKeys(figmaName).some((key) => want.has(key));
}
