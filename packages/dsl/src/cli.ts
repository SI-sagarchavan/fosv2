/**
 * CLI.
 *
 *   fos-dsl check  --tree <f> --theme <f> [--surfaces <f>] [--json]
 *   fos-dsl types  --out <f>
 *   fos-dsl schema --theme <f> [--surfaces <f>] --out <f> [--subset Box,Stack,…]
 *   fos-dsl docs   --out <f>
 *   fos-dsl collapse --tree <f> [--apply <i> --binding <f> --out <f>]
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRegistry, loadSurfaces, loadTheme } from "@fanos/tokens";
import { flatTreeSchema, type FlatTree } from "./flat.js";
import { proposeCollapse, type CollapseProposal } from "./collapse.js";
import { applyCollapse, type Binding } from "./ops.js";
import { validate, type ValidationResult } from "./validate.js";
import { emitTypes } from "./emit/types.js";
import { emitJsonSchema } from "./emit/json-schema.js";
import { emitDocs } from "./emit/docs.js";
import { NODE_TYPES } from "./nodes/index.js";

const USAGE = `fos-dsl — @fanos/dsl vocabulary tools

  fos-dsl check  --tree <file> --theme <file> [--surfaces <file>] [--json]
  fos-dsl types  --out <file>
  fos-dsl schema --theme <file> [--surfaces <file>] --out <file> [--subset A,B,C]
  fos-dsl docs   --out <file>
  fos-dsl collapse --tree <file> [--json]
  fos-dsl collapse --tree <file> --apply <index> --binding <file> --out <file>

Options
  --tree <file>       a flat SDUI tree
  --theme <file>      raw theme export, for token resolution
  --surfaces <file>   surfaces/<theme>.json, needed for surface.* and asset.* refs
  --theme-id <uuid>   only when the theme file holds several themes
  --subset <list>     comma-separated node types; shrinks the agent schema
  --json              machine-readable output
  --apply <index>     apply one proposal from the report, by index
  --binding <file>    { over, as, slice?, fieldMap } — required by --apply

Node types: ${NODE_TYPES.join(", ")}
`;

function parseArgs(argv: readonly string[]): { command?: string; flags: Map<string, string | boolean> } {
  const flags = new Map<string, string | boolean>();
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      command ??= arg;
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq > 0) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      i += 1;
    } else {
      flags.set(key, true);
    }
  }
  return command === undefined ? { flags } : { command, flags };
}

type Flags = Map<string, string | boolean>;

const str = (flags: Flags, key: string): string | undefined => {
  const v = flags.get(key);
  return typeof v === "string" ? v : undefined;
};

const bool = (flags: Flags, key: string): boolean => flags.get(key) === true || flags.get(key) === "true";

function required(flags: Flags, key: string): string {
  const v = str(flags, key);
  if (!v) throw new Error(`missing --${key}`);
  return v;
}

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function buildRegistry(flags: Flags) {
  const theme = loadTheme(resolve(required(flags, "theme")), str(flags, "theme-id"));
  const surfacesPath = str(flags, "surfaces");
  return createRegistry(theme, surfacesPath ? { surfaces: loadSurfaces(resolve(surfacesPath)) } : {});
}

function formatReport(tree: FlatTree, result: ValidationResult): string {
  const out: string[] = [];
  out.push(`${tree.nodes.length} nodes, schemaVersion ${tree.schemaVersion}`);

  for (const [label, issues] of [
    ["ERRORS", result.errors],
    ["WARNINGS", result.warnings],
  ] as const) {
    if (issues.length === 0) continue;
    out.push("", `${label} (${issues.length})`);
    for (const issue of issues) {
      const where = [issue.nodeId, issue.path].filter(Boolean).join(" @ ");
      out.push(`  ${issue.code}  ${where}`);
      out.push(`      ${issue.message}`);
      if (issue.suggestions?.length) out.push(`      did you mean: ${issue.suggestions.join(", ")}`);
    }
  }

  const m = result.metrics;
  out.push("", "METRICS");
  out.push(`  nodes ${m.nodeCount}, maxDepth ${m.maxDepth}`);
  const raw = m.rawValueCount;
  out.push(
    `  rawValueCount ${raw.total} (space:${raw.space} color:${raw.color} size:${raw.size} duration:${raw.duration} other:${raw.other}; positions: ${m.rawPositionCount})`,
  );
  out.push(`  synthetic ${m.syntheticNodeCount}, custom ${m.customNodeCount}`);
  out.push(
    `  tokenCoverage ${(m.tokenCoverage * 100).toFixed(1)}% (${m.tokenisedValueCount} tokenised, ${raw.total} raw, ${m.relativeValueCount} relative)`,
  );
  out.push("");
  out.push(result.ok ? `PASS — 0 errors, ${result.warnings.length} warnings` : `FAIL — ${result.errors.length} errors`);
  return `${out.join("\n")}\n`;
}

/** A proposal list a person reads down, biggest saving first. */
function formatProposals(tree: FlatTree, proposals: readonly CollapseProposal[]): string {
  const out: string[] = [`${tree.nodes.length} nodes, ${proposals.length} collapse proposal(s)`];
  if (proposals.length === 0) {
    out.push("", "Nothing repeats. Siblings group by subtree signature, so a run that");
    out.push("differs by any prop the signature keeps — a gap, a truncation limit —");
    out.push("is reported as no run rather than folded together.");
    return `${out.join("\n")}\n`;
  }

  proposals.forEach((p, i) => {
    out.push("");
    out.push(
      `[${i}] ${p.count}x under ${p.parentId}  ${p.signature}  ` +
        `saves ${p.nodesSaved} nodes (${p.nodesPerMember} each)  ` +
        `${p.contiguous ? "contiguous" : "SCATTERED"}`,
    );
    out.push(`     template ${p.templateId}   members ${p.memberIds.join(", ")}`);
    const varying = Object.entries(p.varyingContent);
    if (varying.length === 0) {
      out.push("     varying content: none — every member carries identical copy, so the");
      out.push("       item's fields cannot be read off the design and must come from a contract");
    } else {
      out.push("     varying content:");
      for (const [nodeId, entries] of varying) {
        for (const entry of entries) {
          const preview = entry.values.map((v) => JSON.stringify(v.slice(0, 40))).join(" | ");
          out.push(`       ${nodeId}.${entry.prop}  ${preview}`);
        }
      }
    }
  });

  out.push("");
  out.push("Nothing was changed. Apply one with:");
  out.push("  fos-dsl collapse --tree <f> --apply <index> --binding <f> --out <f>");
  return `${out.join("\n")}\n`;
}

export function run(argv: readonly string[]): number {
  const { command, flags } = parseArgs(argv);

  if (!command || bool(flags, "help") || command === "help") {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }

  switch (command) {
    case "check": {
      const tree = flatTreeSchema.parse(JSON.parse(readFileSync(resolve(required(flags, "tree")), "utf8")));
      const result = validate(tree, { registry: buildRegistry(flags) });
      if (bool(flags, "json")) {
        process.stdout.write(`${JSON.stringify({ ok: result.ok, errors: result.errors, warnings: result.warnings, metrics: result.metrics }, null, 2)}\n`);
      } else {
        process.stdout.write(formatReport(tree, result));
      }
      return result.ok ? 0 : 1;
    }

    case "types": {
      const out = resolve(required(flags, "out"));
      write(out, emitTypes());
      process.stdout.write(`${out}\n`);
      return 0;
    }

    case "schema": {
      const out = resolve(required(flags, "out"));
      const subsetRaw = str(flags, "subset");
      const subset = subsetRaw?.split(",").map((s) => s.trim()).filter(Boolean);
      const schema = emitJsonSchema({
        registry: buildRegistry(flags),
        ...(subset && subset.length > 0 ? { subset } : {}),
      });
      const json = `${JSON.stringify(schema, null, 2)}\n`;
      write(out, json);
      process.stdout.write(`${out}  ${json.length}B\n`);
      return 0;
    }

    /**
     * Report by default; applying takes an explicit binding file.
     *
     * There is no `--apply-all` and no confidence threshold to pass. A collapse
     * without a data source is not a smaller tree, it is a tree that draws one
     * card where the design drew three — the binding IS the decision, so the
     * command cannot be run without one.
     */
    case "collapse": {
      const treePath = resolve(required(flags, "tree"));
      const tree = flatTreeSchema.parse(JSON.parse(readFileSync(treePath, "utf8")));
      const proposals = proposeCollapse(tree);

      const applyAt = str(flags, "apply");
      if (applyAt === undefined) {
        if (bool(flags, "json")) {
          process.stdout.write(`${JSON.stringify({ nodes: tree.nodes.length, proposals }, null, 2)}\n`);
        } else {
          process.stdout.write(formatProposals(tree, proposals));
        }
        return 0;
      }

      const index = Number(applyAt);
      const proposal = proposals[index];
      if (!Number.isInteger(index) || !proposal) {
        process.stderr.write(
          `--apply ${applyAt}: no such proposal (${proposals.length} available, 0..${Math.max(proposals.length - 1, 0)})\n`,
        );
        return 1;
      }

      const binding = JSON.parse(readFileSync(resolve(required(flags, "binding")), "utf8")) as Binding;
      const out = resolve(required(flags, "out"));
      const next = applyCollapse(tree, proposal, binding);
      write(out, `${JSON.stringify(next, null, 2)}\n`);
      process.stdout.write(
        `${out}\n  ${tree.nodes.length} -> ${next.nodes.length} nodes  ` +
          `(${proposal.count}x ${proposal.templateId} under ${proposal.parentId} over "${binding.over}")\n`,
      );
      return 0;
    }

    case "docs": {
      const out = resolve(required(flags, "out"));
      write(out, emitDocs());
      process.stdout.write(`${out}\n`);
      return 0;
    }

    default:
      process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
      return 1;
  }
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  try {
    return run(argv);
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
