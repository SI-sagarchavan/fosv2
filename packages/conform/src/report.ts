/**
 * Human-readable report.
 *
 * Grouped by code with the title spelled out, because the value of a gate is
 * that someone reads the failure and knows what to do — "C1" on its own teaches
 * nobody anything.
 */

import { CODE_TITLES, issuesByCode, type ConformCode, type ConformResult } from "./issues.js";

const ORDER: ConformCode[] = ["C1", "C2", "C3", "C4", "C5"];

export function formatReport(result: ConformResult, label = "tree"): string {
  const lines: string[] = [];
  const { coverage: c, geometry: g } = result.summary;

  lines.push(
    result.ok
      ? `PASS — ${label}: 0 errors, ${result.warnings.length} warnings`
      : `FAIL — ${label}: ${result.errors.length} errors, ${result.warnings.length} warnings`,
  );
  lines.push(
    `  nodes ${result.summary.nodeCount}   ` +
      `coverage ${c.direct} direct / ${c.absorbed} absorbed / ${c.repeated} repeated / ` +
      `${c.missing} MISSING of ${c.paints} painting IR nodes`,
  );
  if (g.compared > 0) {
    lines.push(
      `  geometry ${g.compared} compared, ${g.skipped} skipped, worst delta ${g.worstDelta.toFixed(2)}px`,
    );
  }
  if (result.summary.waived > 0) {
    lines.push(`  ${result.summary.waived} waived by _meta.deviations`);
  }

  const grouped = issuesByCode([...result.errors, ...result.warnings]);
  for (const code of ORDER) {
    const items = grouped[code];
    if (!items?.length) continue;
    lines.push("");
    lines.push(`${code} — ${CODE_TITLES[code]}   (${items.length})`);
    for (const i of items) {
      const who = i.nodeId ?? i.irId ?? "";
      const mark = i.severity === "warning" ? "warn" : "  ! ";
      lines.push(`  ${mark} ${who.padEnd(22)} ${i.message}`);
    }
  }

  if (result.infos.some((i) => i.waived)) {
    lines.push("");
    lines.push("waived");
    for (const i of result.infos.filter((x) => x.waived)) {
      lines.push(`   ~  ${(i.nodeId ?? "").padEnd(22)} ${i.code}: ${i.waived}`);
    }
  }

  return lines.join("\n") + "\n";
}
