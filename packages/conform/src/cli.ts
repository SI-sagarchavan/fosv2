/**
 * fos-conform — check a DSL tree against the IR it came from.
 *
 *   fos-conform check --tree <f> --ir <f> [--theme <f>] [--boxes <f>]
 *                     [--root-src <id>] [--scale n] [--tolerance n] [--json]
 *
 * `--boxes` is the JSON `fos-render boxes` writes. Without it C2 is skipped and
 * the other four still run, which is the fast path for CI on a pure tree edit.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { flatTreeSchema } from "@fanos/dsl";
import { loadTheme } from "@fanos/tokens";
import { parseFrameIRDocument } from "@fanos/surface-canvas/ir";
import { conform } from "./conform.js";
import { formatReport } from "./report.js";
import type { NodeBox } from "./checks/geometry.js";

const USAGE = `fos-conform — is this DSL tree true to its Figma IR?

Usage:
  fos-conform check --tree <f> --ir <f> [--theme <f>] [--boxes <f>]
                    [--root-src <id>] [--scale n] [--tolerance n] [--json]
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

const readJson = (p: string): unknown => JSON.parse(readFileSync(resolve(p), "utf8"));

export function run(argv: readonly string[]): number {
  const { command, flags } = parseArgs(argv);
  if (command !== "check") {
    process.stdout.write(USAGE);
    return command === undefined || flags.help ? 0 : 1;
  }

  try {
    const tree = flatTreeSchema.parse(readJson(required(flags, "tree")));
    const doc = parseFrameIRDocument(readJson(required(flags, "ir")));
    const theme = flags.theme ? loadTheme(resolve(flags.theme)) : undefined;
    const boxes = flags.boxes ? (readJson(flags.boxes) as NodeBox[]) : undefined;

    const result = conform(tree, doc, {
      theme,
      boxes,
      rootSrc: flags["root-src"],
      geometry: {
        scale: flags.scale ? Number(flags.scale) : undefined,
        tolerance: flags.tolerance ? Number(flags.tolerance) : undefined,
      },
    });

    process.stdout.write(
      flags.json
        ? JSON.stringify(result, null, 2) + "\n"
        : formatReport(result, required(flags, "tree").split("/").pop()!),
    );
    return result.ok ? 0 : 1;
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
}
