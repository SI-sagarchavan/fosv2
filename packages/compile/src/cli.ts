/**
 * fos-compile — IR in, DSL tree out.
 *
 *   fos-compile build --ir <f> --theme <f> [--surfaces <f>] [--out <f>] [--surfaces-out <f>] [--json]
 *
 * Exits non-zero when the tree it produced does not validate, so a broken
 * compiler can never quietly write a broken fixture.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRegistry, loadSurfaces, loadTheme } from "@fanos/tokens";
import { validate } from "@fanos/dsl";
import { parseFrameIRDocument } from "@fanos/surface-canvas/ir";
import { compile } from "./compile.js";

const USAGE = `fos-compile — deterministic Figma IR -> DSL tree

Usage:
  fos-compile build --ir <f> --theme <f> [--surfaces <f>] [--out <f>] [--surfaces-out <f>] [--json]
`;

function parseArgs(argv: readonly string[]): { command?: string; flags: Record<string, string> } {
  const [command, ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = rest[i + 1];
    flags[key] = next && !next.startsWith("--") ? (i++, next) : "true";
  }
  return { command, flags };
}

function required(flags: Record<string, string>, key: string): string {
  const v = flags[key];
  if (!v || v === "true") throw new Error(`missing --${key}`);
  return v;
}

export function run(argv: readonly string[]): number {
  const { command, flags } = parseArgs(argv);
  if (command !== "build") {
    process.stdout.write(USAGE);
    return command === undefined || flags.help ? 0 : 1;
  }

  try {
    const doc = parseFrameIRDocument(JSON.parse(readFileSync(resolve(required(flags, "ir")), "utf8")));
    const theme = loadTheme(resolve(required(flags, "theme")));
    const surfaces = flags.surfaces ? loadSurfaces(resolve(flags.surfaces)) : undefined;

    const result = compile(doc, { theme, surfaces });

    /**
     * Validate against the theme's surfaces PLUS the ones this compile needs.
     *
     * A tree that references `surface.news_later` before anyone has written it
     * is not wrong — the paint is real and the spec is exact. Reporting T1 for
     * every one of them would bury the errors that matter, so the required
     * surfaces are merged in and listed separately as work to do.
     */
    const merged = {
      assets: surfaces?.assets ?? new Map<string, string>(),
      surfaces: new Map([
        ...(surfaces?.surfaces ?? new Map()),
        ...result.requiredSurfaces.map((r) => [r.name, r.spec] as const),
      ]),
    };
    const check = validate(result.tree, { registry: createRegistry(theme, { surfaces: merged }) });

    if (flags.out) {
      writeFileSync(resolve(flags.out), JSON.stringify(result.tree, null, 2) + "\n");
    }
    if (flags["surfaces-out"]) {
      writeFileSync(
        resolve(flags["surfaces-out"]),
        JSON.stringify({ surfaces: Object.fromEntries(result.requiredSurfaces.map((r) => [r.name, r.spec])) }, null, 2) + "\n",
      );
    }

    if (flags.json) {
      process.stdout.write(
        JSON.stringify(
          { stats: result.stats, requiredSurfaces: result.requiredSurfaces, notes: result.notes, validation: { ok: check.ok, errors: check.errors } },
          null,
          2,
        ) + "\n",
      );
      return check.ok ? 0 : 1;
    }

    const s = result.stats;
    process.stdout.write(
      `${check.ok ? "PASS" : "FAIL"} — ${doc.rootNodeId}: ${s.emitted} nodes from ${s.irNodes} IR nodes ` +
        `(${s.absorbed} absorbed)\n` +
        `  validation ${check.errors.length} errors, ${check.warnings.length} warnings\n` +
        `  token coverage ${(check.metrics.tokenCoverage * 100).toFixed(1)}%\n`,
    );
    if (result.requiredSurfaces.length) {
      process.stdout.write(`  ${result.requiredSurfaces.length} surfaces not in the theme:\n`);
      for (const r of result.requiredSurfaces) {
        process.stdout.write(`     ${r.name.padEnd(28)} ${JSON.stringify(r.spec)}\n`);
      }
    }
    const byKind: Record<string, number> = {};
    for (const n of result.notes) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
    if (Object.keys(byKind).length) {
      process.stdout.write(
        `  notes: ${Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join("  ")}\n`,
      );
    }
    for (const e of check.errors.slice(0, 12)) {
      process.stdout.write(`   ! ${e.code} ${e.nodeId ?? ""} ${e.path ?? ""} — ${e.message}\n`);
    }
    return check.ok ? 0 : 1;
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
}
