/**
 * fos-render CLI
 *
 *   fos-render png    --tree <f> --data <f> --theme <f> --out <f> [--width n]
 *   fos-render boxes  --tree <f> --data <f> --theme <f> [--out <f>]
 *   fos-render diff   --tree <f> --expected <f> --out <dir>
 *   fos-render report --tree <f> --expected <f>
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { flatTreeSchema, type FlatTree } from "@fanos/dsl";
import {
  createRegistry,
  emitCss,
  loadSurfaces,
  loadTheme,
  LOCAL_ASSET_CONTEXT,
} from "@fanos/tokens";
import { measureNodeBoxes, renderToPng, writePng, closeBrowser } from "./harness/renderToPng.js";
import { diff } from "./harness/diff.js";
import { mapRegionsToNodes, type NodeBox } from "./harness/mapRegions.js";
import { FONT_FACE_CSS } from "./fonts.js";

const USAGE = `fos-render — headless SDUI render + pixel diff

Usage:
  fos-render png    --tree <f> --data <f> --theme <f> [--surfaces <f>] --out <f> [--width n] [--viewport n] [--design-width n] [--background #rrggbb]
  fos-render boxes  --tree <f> --data <f> --theme <f> [--surfaces <f>] [--out <f>] [--width n] [--viewport n] [--design-width n]
  fos-render diff   --tree <f> --data <f> --theme <f> --expected <f> --out <dir> [--width n]
  fos-render report --tree <f> --data <f> --theme <f> --expected <f> [--width n]
`;

function parseArgs(argv: readonly string[]): { command?: string; flags: Record<string, string> } {
  const [command, ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = rest[i + 1] && !rest[i + 1]!.startsWith("--") ? rest[++i]! : "true";
      flags[key] = val;
    }
  }
  return { command, flags };
}

function required(flags: Record<string, string>, key: string): string {
  const v = flags[key];
  if (!v) throw new Error(`missing --${key}`);
  return v;
}

function loadTree(path: string): FlatTree {
  return flatTreeSchema.parse(JSON.parse(readFileSync(resolve(path), "utf8")));
}

function loadData(path: string | undefined): Record<string, unknown> | undefined {
  if (!path) return undefined;
  return JSON.parse(readFileSync(resolve(path), "utf8")) as Record<string, unknown>;
}

function themeCss(themePath: string, surfacesPath?: string): string {
  const theme = loadTheme(resolve(themePath));
  const surfaces = surfacesPath ? loadSurfaces(resolve(surfacesPath)) : undefined;
  const { css } = emitCss(theme, {
    surfaces,
    assets: LOCAL_ASSET_CONTEXT,
    scope: "root",
  });
  return css;
}

export async function run(argv: readonly string[]): Promise<number> {
  const { command, flags } = parseArgs(argv);

  if (!command || flags.help === "true" || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return command && command !== "--help" && command !== "-h" ? 0 : command ? 0 : 1;
  }

  try {
    switch (command) {
      case "png": {
        const tree = loadTree(required(flags, "tree"));
        const data = loadData(flags.data);
        const css = themeCss(required(flags, "theme"), flags.surfaces);
        const width = Number(flags.width ?? 534);
        // Defaults to a desktop page. The breakpoint is a property of the PAGE
        // the card sits on, not of the card, so tying it to --width silently
        // renders every component one breakpoint too small. Pass --viewport 390
        // for a mobile page.
        const viewport = Number(flags.viewport ?? 1440);
        const designWidth = flags["design-width"] ? Number(flags["design-width"]) : undefined;
        const background = flags.background;
        const buf = await renderToPng(tree, {
          data,
          themeCss: css,
          fontCss: FONT_FACE_CSS,
          width,
          viewport,
          ...(designWidth ? { designWidth } : {}),
          ...(background ? { background } : {}),
        });
        writePng(resolve(required(flags, "out")), buf);
        process.stdout.write(`wrote ${flags.out} (${buf.length} bytes)\n`);
        return 0;
      }
      /**
       * Measure every node's rendered box and write it as JSON.
       *
       * Feeds `fos-conform check --boxes`, which compares each one against the
       * Figma bbox for that node's `src`. Kept as a separate command rather than
       * folded into `png` so a conformance run in CI never needs to produce or
       * store an image.
       */
      case "boxes": {
        const tree = loadTree(required(flags, "tree"));
        const data = loadData(flags.data);
        const css = themeCss(required(flags, "theme"), flags.surfaces);
        const width = Number(flags.width ?? 534);
        const viewport = Number(flags.viewport ?? 1440);
        const designWidth = flags["design-width"] ? Number(flags["design-width"]) : undefined;
        const boxes = await measureNodeBoxes(tree, {
          data,
          themeCss: css,
          fontCss: FONT_FACE_CSS,
          width,
          viewport,
          ...(designWidth ? { designWidth } : {}),
          ...(flags.background ? { background: flags.background } : {}),
        });
        const json = JSON.stringify(boxes, null, 2) + "\n";
        if (flags.out) {
          writeFileSync(resolve(flags.out), json);
          process.stdout.write(`wrote ${flags.out} (${boxes.length} boxes)\n`);
        } else {
          process.stdout.write(json);
        }
        return 0;
      }
      case "diff": {
        const tree = loadTree(required(flags, "tree"));
        const data = loadData(flags.data);
        const css = themeCss(required(flags, "theme"), flags.surfaces);
        const width = Number(flags.width ?? 534);
        // Defaults to a desktop page. The breakpoint is a property of the PAGE
        // the card sits on, not of the card, so tying it to --width silently
        // renders every component one breakpoint too small. Pass --viewport 390
        // for a mobile page.
        const viewport = Number(flags.viewport ?? 1440);
        const designWidth = flags["design-width"] ? Number(flags["design-width"]) : undefined;
        const background = flags.background;
        const actual = await renderToPng(tree, {
          data,
          themeCss: css,
          fontCss: FONT_FACE_CSS,
          width,
          viewport,
          ...(designWidth ? { designWidth } : {}),
          ...(background ? { background } : {}),
        });
        const expected = readFileSync(resolve(required(flags, "expected")));
        const result = diff(actual, expected);
        const outDir = resolve(required(flags, "out"));
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, "actual.png"), actual);
        writeFileSync(join(outDir, "diff.png"), result.diffPng);
        writeFileSync(
          join(outDir, "report.json"),
          JSON.stringify(
            {
              score: result.score,
              mismatchCount: result.mismatchCount,
              regions: result.regions,
            },
            null,
            2,
          ),
        );
        process.stdout.write(`score=${result.score.toFixed(6)} regions=${result.regions.length}\n`);
        return result.score === 0 ? 0 : 1;
      }
      case "report": {
        const tree = loadTree(required(flags, "tree"));
        const data = loadData(flags.data);
        const css = themeCss(required(flags, "theme"), flags.surfaces);
        const width = Number(flags.width ?? 534);
        // Defaults to a desktop page. The breakpoint is a property of the PAGE
        // the card sits on, not of the card, so tying it to --width silently
        // renders every component one breakpoint too small. Pass --viewport 390
        // for a mobile page.
        const viewport = Number(flags.viewport ?? 1440);
        const designWidth = flags["design-width"] ? Number(flags["design-width"]) : undefined;
        const background = flags.background;
        const actual = await renderToPng(tree, {
          data,
          themeCss: css,
          fontCss: FONT_FACE_CSS,
          width,
          viewport,
          ...(designWidth ? { designWidth } : {}),
          ...(background ? { background } : {}),
        });
        const expected = readFileSync(resolve(required(flags, "expected")));
        const result = diff(actual, expected);
        // Without a live DOM we cannot map regions to nodes here; the harness
        // page path does. Report score + regions; node mapping is best-effort empty.
        const mapped = mapRegionsToNodes(result.regions, [] as NodeBox[], tree);
        const report = {
          score: result.score,
          mismatchCount: result.mismatchCount,
          width: result.width,
          height: result.height,
          regions: mapped,
        };
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return result.score === 0 ? 0 : 1;
      }
      default:
        process.stderr.write(`unknown command: ${command}\n${USAGE}`);
        return 1;
    }
  } finally {
    await closeBrowser();
  }
}

// silence unused import when surfaces registry is needed later
void createRegistry;
