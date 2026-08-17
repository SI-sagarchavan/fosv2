/**
 * Geometry measurement by spawning `fos-render boxes`.
 *
 * Out of process on purpose. Measuring means rendering the tree in a real
 * browser, and linking Playwright into the control plane would put a browser
 * download in the API's install and a browser process in its memory profile.
 * `@fanos/renderer` already splits its framework-free entry from
 * `@fanos/renderer/harness` for exactly this reason; this adapter respects that
 * seam by talking to the CLI instead of importing across it.
 *
 * Nothing here throws. A missing binary, a missing chromium, a crashed render
 * and a timeout all come back as `{ measured: false, reason }`, because the
 * caller's job is to RECORD that geometry went unchecked — the failure mode
 * this whole check exists to kill is a gate that silently compares nothing.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { GeometryMeasurer, MeasureOutcome, MeasuredBox } from "../domain/ports.js";

const run = promisify(execFile);

export interface MeasurerOptions {
  /** Absolute path to the renderer CLI. Resolved from the package when unset. */
  cliPath?: string;
  /** Hard cap. A hung browser must not hold a run open forever. */
  timeoutMs?: number;
}

export function createFosRenderMeasurer(options: MeasurerOptions = {}): GeometryMeasurer {
  const timeout = options.timeoutMs ?? 60_000;

  return {
    async measure(input): Promise<MeasureOutcome> {
      const cli = options.cliPath ?? resolveCli();
      if (!cli) {
        return {
          measured: false,
          reason:
            "renderer CLI not found — geometry was NOT checked. " +
            "Install @fanos/renderer and its chromium (`pnpm --filter @fanos/renderer playwright:install`), " +
            "or set GEOMETRY_CLI_PATH.",
        };
      }

      let dir: string | undefined;
      try {
        dir = await mkdtemp(join(tmpdir(), "fanos-measure-"));
        const treePath = join(dir, "tree.json");
        const themePath = join(dir, "theme.json");
        const outPath = join(dir, "boxes.json");

        await Promise.all([
          writeFile(treePath, JSON.stringify(input.tree)),
          writeFile(themePath, JSON.stringify(input.theme)),
        ]);

        const args = ["boxes", "--tree", treePath, "--theme", themePath, "--out", outPath];

        if (input.surfaces !== undefined) {
          const surfacesPath = join(dir, "surfaces.json");
          await writeFile(surfacesPath, JSON.stringify(input.surfaces));
          args.push("--surfaces", surfacesPath);
        }
        if (input.width !== undefined) {
          // Width AND viewport: the emitted media queries key off the viewport,
          // so leaving it at a default would measure desktop type at a mobile
          // breakpoint and report every text box as wrong.
          args.push("--width", String(input.width), "--viewport", String(input.width));
        }

        await run(process.execPath, [cli, ...args], { timeout, maxBuffer: 64 * 1024 * 1024 });

        const boxes = JSON.parse(await readFile(outPath, "utf8")) as MeasuredBox[];
        if (!Array.isArray(boxes) || boxes.length === 0) {
          return { measured: false, reason: "renderer produced no boxes" };
        }
        return { measured: true, boxes };
      } catch (err) {
        return { measured: false, reason: messageOf(err) };
      } finally {
        if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

/**
 * Find `dist/bin.js` by landmark, not by counting `..`.
 *
 * `@fanos/renderer` restricts its `exports`, so `package.json` is not
 * resolvable — but `./styles.css` is, and the package root is the ancestor that
 * owns both `package.json` and `dist`. Same approach the studio's preview uses.
 */
function resolveCli(): string | null {
  try {
    const require = createRequire(import.meta.url);
    let dir = dirname(require.resolve("@fanos/renderer/styles.css"));

    for (let i = 0; i < 5; i++) {
      const bin = join(dir, "dist/bin.js");
      if (existsSync(join(dir, "package.json")) && existsSync(bin)) return bin;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}

/** stderr beats the generic "Command failed" — it carries the real cause. */
function messageOf(err: unknown): string {
  const e = err as { stderr?: unknown; killed?: boolean; message?: string };
  if (e.killed) return "renderer timed out";
  const stderr = typeof e.stderr === "string" ? e.stderr.trim() : "";
  if (stderr) return stderr.split("\n").slice(-3).join(" ").slice(0, 400);
  return e.message?.slice(0, 400) ?? String(err);
}

/** Records that geometry was deliberately not measured. */
export function createDisabledMeasurer(): GeometryMeasurer {
  return {
    async measure(): Promise<MeasureOutcome> {
      return { measured: false, reason: "geometry gate disabled (GEOMETRY_GATE=off)" };
    },
  };
}
