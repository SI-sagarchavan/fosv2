/**
 * Report rendering for `fos-tokens check`. Pure — takes a result, returns a
 * string. The CLI decides where it goes.
 */

import type { Finding, FindingCode, ValidationResult } from "./validate.js";
import { compareTokenNames } from "./normalize.js";
import type { NormalizedTheme } from "./types.js";

const TITLES: Record<FindingCode, string> = {
  E1: "type.* breakpoint parity",
  E2: "surface references an unresolvable token",
  E3: "two inset borders on one surface",
  E4: "gradient stop ordering",
  E5: "malformed or out-of-range value",
  E6: "core scale collision",
  E7: "canonical ref collision",
  W1: "near-duplicate token names",
  W2: "opaque shadow",
  W3: "typography weight disagrees with the name suffix",
  W4: "empty category",
  W5: "letter_spacing never authored",
  W6: "collapsed gradient stops",
  I1: "alias density",
};

function group(findings: readonly Finding[]): Array<[FindingCode, Finding[]]> {
  const map = new Map<FindingCode, Finding[]>();
  for (const f of findings) {
    const list = map.get(f.code);
    if (list) list.push(f);
    else map.set(f.code, [f]);
  }
  return [...map.entries()].sort((a, b) => compareTokenNames(a[0], b[0]));
}

function section(label: string, findings: readonly Finding[]): string[] {
  if (findings.length === 0) return [];
  const out: string[] = ["", `${label} (${findings.length})`];
  for (const [code, list] of group(findings)) {
    out.push(`  ${code}  ${TITLES[code]} — ${list.length}`);
    for (const f of list) out.push(`      ${f.path}`, `        ${f.message}`);
  }
  return out;
}

export function formatReport(theme: NormalizedTheme, result: ValidationResult): string {
  const out: string[] = [];
  out.push(`${theme.name}  (${theme.id})`);
  out.push(
    `  ${theme.color.light.size} colours · ${theme.space.size} space · ${theme.radius.size} radius · ` +
      `${theme.opacity.size} opacity · ${theme.gradient.light.size} gradients · ${theme.shadow.light.size} shadows`,
  );

  out.push(...section("ERRORS", result.errors));
  out.push(...section("WARNINGS", result.warnings));
  out.push(...section("INFO", result.infos));

  out.push("");
  out.push(
    result.ok
      ? `PASS — 0 errors, ${result.warnings.length} warnings`
      : `FAIL — ${result.errors.length} errors in ${new Set(result.errors.map((f) => f.code)).size} classes, ${result.warnings.length} warnings`,
  );
  return `${out.join("\n")}\n`;
}

export interface JsonReport {
  theme: { id: string; name: string; slug: string };
  ok: boolean;
  counts: Record<FindingCode, number>;
  findings: Finding[];
}

export function jsonReport(theme: NormalizedTheme, result: ValidationResult): JsonReport {
  return {
    theme: { id: theme.id, name: theme.name, slug: theme.slug },
    ok: result.ok,
    counts: result.counts,
    findings: result.findings,
  };
}
