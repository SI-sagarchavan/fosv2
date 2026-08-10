/**
 * Tailwind bridges.
 *
 * Both emitters REFERENCE `--fos-*` vars and never duplicate a value. Copying
 * the numbers in would create a second source of truth that silently rots the
 * first time someone edits the theme and rebuilds only the CSS.
 */

import type { NormalizedTheme } from "../types.js";
import { sortedEntries, typeIntersection } from "../normalize.js";
import { cssVarName, dashify } from "../refs.js";
import { DEFAULT_BREAKPOINTS, type Breakpoints } from "../config.js";
import { formatPx } from "./css.js";

export interface EmitTailwindOptions {
  breakpoints?: Breakpoints;
}

/** Tailwind's own key for a token — dashed, since that is what a utility class reads. */
function twKey(leaf: string): string {
  return dashify(leaf);
}

/**
 * Tailwind v4 `@theme` block.
 *
 * Maps our vocabulary onto Tailwind's namespaces so `bg-core-sec-500`, `p-4`,
 * `rounded-2xl`, `shadow-md` and `text-dp_2_regular` all resolve to our tokens.
 */
export function emitTailwindV4(theme: NormalizedTheme, options: EmitTailwindOptions = {}): string {
  const breakpoints = options.breakpoints ?? DEFAULT_BREAKPOINTS;
  const out: string[] = [];
  const line = (k: string, v: string) => out.push(`  ${k}: ${v};`);

  out.push(`/* @fanos/tokens — Tailwind v4 theme for ${theme.name} (${theme.id}) */`);
  out.push("/* Generated file. Do not edit. Regenerate with `fos-tokens tailwind`. */");
  out.push("/* Import AFTER the emitted tokens.css — every value here is a reference to it. */");
  out.push("");
  out.push("@theme {");

  out.push("  /* breakpoints */");
  line("--breakpoint-md", formatPx(breakpoints.md));
  line("--breakpoint-lg", formatPx(breakpoints.lg));

  out.push("", "  /* spacing — p-4, gap-0_5, … */");
  for (const [leaf] of sortedEntries(theme.space)) line(`--spacing-${twKey(leaf)}`, `var(${cssVarName(`space.${leaf}`)})`);

  out.push("", "  /* radius — rounded-2xl, … */");
  for (const [leaf] of sortedEntries(theme.radius)) line(`--radius-${twKey(leaf)}`, `var(${cssVarName(`radius.${leaf}`)})`);

  out.push("", "  /* color — bg-core-sec-500, text-text-invert-high, … */");
  for (const [leaf] of sortedEntries(theme.color.light)) line(`--color-${twKey(leaf)}`, `var(${cssVarName(`color.${leaf}`)})`);

  out.push("", "  /* shadow — shadow-md, … */");
  for (const [leaf] of sortedEntries(theme.shadow.light)) line(`--shadow-${twKey(leaf)}`, `var(${cssVarName(`shadow.${leaf}`)})`);

  out.push("", "  /* type — text-dp_2_regular carries leading, weight and tracking with it */");
  for (const leaf of typeIntersection(theme)) {
    const base = cssVarName(`type.${leaf}`);
    line(`--text-${leaf}`, `var(${base}-size)`);
    line(`--text-${leaf}--line-height`, `var(${base}-leading)`);
    line(`--text-${leaf}--font-weight`, `var(${base}-weight)`);
    line(`--text-${leaf}--letter-spacing`, `var(${base}-tracking)`);
  }

  // Gradients have no first-class Tailwind namespace. Exposed under a custom one
  // so they are reachable as `bg-(--gradient-sec-vert-1)` rather than lost.
  if (theme.gradient.light.size > 0) {
    out.push("", "  /* gradient — no Tailwind namespace; use bg-(--gradient-…) */");
    for (const [leaf] of sortedEntries(theme.gradient.light)) {
      line(`--gradient-${twKey(leaf)}`, `var(${cssVarName(`gradient.${leaf}`)})`);
    }
  }

  out.push("}");
  return `${out.join("\n")}\n`;
}

/** Tailwind v3 preset, for a consumer that has not migrated yet. */
export function emitTailwindV3(theme: NormalizedTheme, options: EmitTailwindOptions = {}): string {
  const breakpoints = options.breakpoints ?? DEFAULT_BREAKPOINTS;

  const record = (entries: Array<[string, string]>, indent: string): string =>
    entries.map(([k, v]) => `${indent}${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n");

  const spacing = sortedEntries(theme.space).map(
    ([leaf]) => [twKey(leaf), `var(${cssVarName(`space.${leaf}`)})`] as [string, string],
  );
  const radius = sortedEntries(theme.radius).map(
    ([leaf]) => [twKey(leaf), `var(${cssVarName(`radius.${leaf}`)})`] as [string, string],
  );
  const colors = sortedEntries(theme.color.light).map(
    ([leaf]) => [twKey(leaf), `rgb(var(${cssVarName(`color.${leaf}`)}-rgb) / <alpha-value>)`] as [string, string],
  );
  const shadows = sortedEntries(theme.shadow.light).map(
    ([leaf]) => [twKey(leaf), `var(${cssVarName(`shadow.${leaf}`)})`] as [string, string],
  );
  const opacity = sortedEntries(theme.opacity).map(
    ([leaf]) => [twKey(leaf), `var(${cssVarName(`opacity.${leaf}`)})`] as [string, string],
  );

  const fontSize = typeIntersection(theme)
    .map((leaf) => {
      const base = cssVarName(`type.${leaf}`);
      return [
        `      ${JSON.stringify(leaf)}: [`,
        `        ${JSON.stringify(`var(${base}-size)`)},`,
        "        {",
        `          lineHeight: ${JSON.stringify(`var(${base}-leading)`)},`,
        `          fontWeight: ${JSON.stringify(`var(${base}-weight)`)},`,
        `          letterSpacing: ${JSON.stringify(`var(${base}-tracking)`)},`,
        "        },",
        "      ],",
      ].join("\n");
    })
    .join("\n");

  return `/* @fanos/tokens — Tailwind v3 preset for ${theme.name} (${theme.id}) */
/* Generated file. Do not edit. Regenerate with \`fos-tokens tailwind --v3\`. */
/* Every value references a --fos-* var; load the emitted tokens.css first. */

/** @type {import('tailwindcss').Config} */
module.exports = {
  theme: {
    screens: {
      "md": ${JSON.stringify(formatPx(breakpoints.md))},
      "lg": ${JSON.stringify(formatPx(breakpoints.lg))},
    },
    extend: {
      colors: {
${record(colors, "        ")}
      },
      spacing: {
${record(spacing, "        ")}
      },
      borderRadius: {
${record(radius, "        ")}
      },
      boxShadow: {
${record(shadows, "        ")}
      },
      opacity: {
${record(opacity, "        ")}
      },
      fontSize: {
${fontSize}
      },
    },
  },
};
`;
}

/**
 * Best-effort read of the installed Tailwind major from a package manifest's
 * dependency ranges. Returns undefined when Tailwind is absent or the range is
 * not a plain semver.
 */
export function detectTailwindMajor(manifest: unknown): number | undefined {
  if (!manifest || typeof manifest !== "object") return undefined;
  const pkg = manifest as Record<string, Record<string, string> | undefined>;
  for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    const range = pkg[field]?.["tailwindcss"];
    if (!range) continue;
    const m = /(\d+)/.exec(range);
    if (m) return Number.parseInt(m[1]!, 10);
  }
  return undefined;
}

