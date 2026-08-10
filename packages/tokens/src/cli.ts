/**
 * Part 7 — CLI.
 *
 *   fos-tokens build    --theme <f> --surfaces <f> --out <dir> [--scope root|attr]
 *   fos-tokens check    --theme <f> --surfaces <f> [--json]
 *   fos-tokens types    --theme <f> --out <f>
 *   fos-tokens tailwind --theme <f> --out <f> [--v3]
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadSurfaces, loadTheme } from "./load.js";
import { validateTheme } from "./validate.js";
import { formatReport, jsonReport } from "./report.js";
import { emitCss } from "./emit/css.js";
import { emitTypes } from "./emit/types.js";
import { detectTailwindMajor, emitTailwindV3, emitTailwindV4 } from "./emit/tailwind.js";
import { DEFAULT_BREAKPOINTS } from "./config.js";
import type { SurfaceSet } from "./raw-schema.js";

const USAGE = `fos-tokens — @fanos/tokens compiler

  fos-tokens build    --theme <file> [--surfaces <file>] --out <dir> [options]
  fos-tokens check    --theme <file> [--surfaces <file>] [--json]
  fos-tokens types    --theme <file> [--surfaces <file>] --out <file>
  fos-tokens tailwind --theme <file> --out <file> [--v3]

Options
  --theme <file>                 raw theme export, keyed by theme UUID
  --theme-id <uuid>              required only when the file holds several themes
  --surfaces <file>              surfaces/<theme>.json
  --out <path>                   output directory (build) or file (types, tailwind)
  --scope root|attr              :root, or [data-fos-theme="<slug>"]   (default: root)
  --md <px> --lg <px>            breakpoints                           (default: 768, 1280)
  --allow-partial-typography     emit styles missing on some breakpoint, with fallback
  --v3                           tailwind: emit a v3 JS preset instead of a v4 @theme block
  --json                         check: machine-readable output
  --force                        build: emit even though validation failed
`;

interface Args {
  command: string | undefined;
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: readonly string[]): Args {
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
  return { command, flags };
}

function str(flags: Args["flags"], key: string): string | undefined {
  const v = flags.get(key);
  return typeof v === "string" ? v : undefined;
}

function bool(flags: Args["flags"], key: string): boolean {
  return flags.get(key) === true || flags.get(key) === "true";
}

function num(flags: Args["flags"], key: string): number | undefined {
  const v = str(flags, key);
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function required(flags: Args["flags"], key: string): string {
  const v = str(flags, key);
  if (!v) throw new Error(`missing --${key}`);
  return v;
}

function breakpointsFrom(flags: Args["flags"]) {
  return {
    md: num(flags, "md") ?? DEFAULT_BREAKPOINTS.md,
    lg: num(flags, "lg") ?? DEFAULT_BREAKPOINTS.lg,
  };
}

function loadInputs(flags: Args["flags"]) {
  const theme = loadTheme(resolve(required(flags, "theme")), str(flags, "theme-id"));
  const surfacesPath = str(flags, "surfaces");
  const surfaces: SurfaceSet | undefined = surfacesPath ? loadSurfaces(resolve(surfacesPath)) : undefined;
  return { theme, surfaces };
}

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

/** Short content hash for cache busting. */
function hash(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex").slice(0, 16);
}

/** Walk up from `start` looking for the nearest package.json. */
function findManifest(start: string): unknown | undefined {
  let dir = resolve(start);
  for (;;) {
    try {
      return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  }
}

export function run(argv: readonly string[]): number {
  const { command, flags } = parseArgs(argv);

  if (!command || bool(flags, "help") || command === "help") {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }

  switch (command) {
    case "check": {
      const { theme, surfaces } = loadInputs(flags);
      const result = validateTheme(theme, surfaces ? { surfaces } : {});
      if (bool(flags, "json")) {
        process.stdout.write(`${JSON.stringify(jsonReport(theme, result), null, 2)}\n`);
      } else {
        process.stdout.write(formatReport(theme, result));
      }
      return result.ok ? 0 : 1;
    }

    case "build": {
      const { theme, surfaces } = loadInputs(flags);
      const outDir = resolve(required(flags, "out"));
      const scope = str(flags, "scope") === "attr" ? ("attr" as const) : ("root" as const);
      const allowPartialTypography = bool(flags, "allow-partial-typography");
      const breakpoints = breakpointsFrom(flags);

      const result = validateTheme(theme, surfaces ? { surfaces } : {});
      process.stderr.write(formatReport(theme, result));
      if (!result.ok && !bool(flags, "force")) {
        process.stderr.write("\nbuild aborted — fix the errors above, or pass --force.\n");
        return 1;
      }

      const css = emitCss(theme, {
        scope,
        breakpoints,
        allowPartialTypography,
        ...(surfaces ? { surfaces } : {}),
      });
      const types = emitTypes(theme, { allowPartialTypography, ...(surfaces ? { surfaces } : {}) });
      const tailwind = emitTailwindV4(theme, { breakpoints });

      for (const warning of css.warnings) process.stderr.write(`warn: ${warning}\n`);

      const files: Array<[string, string]> = [
        ["tokens.css", css.css],
        ["tokens.d.ts", types],
        ["tailwind.css", tailwind],
      ];
      for (const [name, contents] of files) write(join(outDir, name), contents);

      // Sorted, no timestamp — the manifest is part of the deterministic output.
      const manifest = {
        theme: { id: theme.id, name: theme.name, slug: theme.slug },
        scope,
        breakpoints,
        files: Object.fromEntries(files.map(([name, contents]) => [name, hash(contents)])),
      };
      write(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

      for (const [name, contents] of files) {
        process.stdout.write(`${join(outDir, name)}  ${hash(contents)}  ${contents.length}B\n`);
      }
      return 0;
    }

    case "types": {
      const { theme, surfaces } = loadInputs(flags);
      const out = resolve(required(flags, "out"));
      write(
        out,
        emitTypes(theme, {
          allowPartialTypography: bool(flags, "allow-partial-typography"),
          ...(surfaces ? { surfaces } : {}),
        }),
      );
      process.stdout.write(`${out}\n`);
      return 0;
    }

    case "tailwind": {
      const { theme } = loadInputs(flags);
      const out = resolve(required(flags, "out"));
      const breakpoints = breakpointsFrom(flags);
      const v3 = bool(flags, "v3");

      const major = detectTailwindMajor(findManifest(process.cwd()));
      if (major !== undefined) {
        const want = v3 ? 3 : 4;
        if (major !== want) {
          process.stderr.write(
            `warn: emitting a Tailwind v${want} ${v3 ? "preset" : "@theme block"} but tailwindcss@${major} is installed — ` +
              `${v3 ? "drop --v3" : "pass --v3"} to match.\n`,
          );
        }
      }

      write(out, v3 ? emitTailwindV3(theme, { breakpoints }) : emitTailwindV4(theme, { breakpoints }));
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
