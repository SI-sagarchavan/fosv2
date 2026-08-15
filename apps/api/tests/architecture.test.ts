/**
 * The architecture gate.
 *
 * Ports and adapters decay silently: someone needs one field, imports the
 * Drizzle row type "just here", and six months later the domain is welded to
 * the ORM again. Nothing in code review reliably catches that. This does.
 *
 * The rule is one sentence: **`kernel/`, `domain/` and `app/` may not import
 * infrastructure.** Adapters may import anything — that is what they are for.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/**
 * Packages that mean "infrastructure" in this codebase. `@fanos/*` is on the
 * list because the toolchain is a driven dependency like any other — the whole
 * point of `Toolchain` is that the pipeline does not know which compiler is
 * behind it.
 */
const INFRASTRUCTURE = [
  "drizzle-orm",
  "postgres",
  "fastify",
  "bullmq",
  "ioredis",
  "@fanos/compile",
  "@fanos/conform",
  "@fanos/dsl",
  "@fanos/surface-canvas",
  "@fanos/tokens",
];

/** Paths a pure layer may never reach into, whatever the specifier looks like. */
const INFRASTRUCTURE_PATHS = ["platform/db", "platform/http", "/adapters/"];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
}

const ALL = walk(SRC);
const pure = ALL.filter(
  (f) =>
    f.includes("/kernel/") ||
    f.includes("/domain/") ||
    f.includes("/app/"),
);

describe("the pure layers", () => {
  it("exist — a passing gate over an empty set proves nothing", () => {
    expect(pure.length).toBeGreaterThan(10);
  });

  for (const file of pure) {
    const name = relative(SRC, file);

    it(`${name} imports no infrastructure`, () => {
      const offenders = importsOf(file).filter(
        (spec) =>
          INFRASTRUCTURE.includes(spec) ||
          INFRASTRUCTURE_PATHS.some((p) => spec.includes(p)),
      );
      expect(offenders).toEqual([]);
    });

    it(`${name} does not name a persistence row type`, () => {
      // `SurfaceRow`, `RunRow` and friends are the shapes the database chose.
      // A domain file naming one is the coupling this whole refactor removed.
      expect(readFileSync(file, "utf8")).not.toMatch(/\b\w+Row\b/);
    });
  }
});

describe("determinism", () => {
  // The clock is a port. `publishedAt` assertions go flaky the moment a service
  // reads the wall clock directly, and a run's timings stop being reproducible.
  const domainAndApp = pure.filter((f) => !f.includes("/kernel/"));

  for (const file of domainAndApp) {
    it(`${relative(SRC, file)} reads the clock through the port`, () => {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/\bnew Date\(\)/);
      expect(source).not.toMatch(/\bDate\.now\(\)/);
      expect(source).not.toMatch(/\bMath\.random\(\)/);
    });
  }
});

describe("the composition root", () => {
  /**
   * `context.ts` chooses adapters; `index.ts` and `worker.ts` are the two
   * driving adapters that start a process and are allowed to reach for the
   * transport they drive. Everything else must go through a port.
   */
  const COMPOSITION = ["context.ts", "index.ts", "worker.ts"];

  it("is the only place that picks adapters", () => {
    // Anything else importing a concrete adapter means a service reached past
    // its port — the failure mode this structure exists to prevent.
    const importers = ALL.filter((f) => !COMPOSITION.includes(relative(SRC, f)))
      .filter((f) =>
        importsOf(f).some((spec) => spec.includes("adapters/") && !spec.endsWith("routes.js")),
      );

    expect(importers.map((f) => relative(SRC, f))).toEqual([]);
  });

  it("wires every port", () => {
    const source = readFileSync(join(SRC, "context.ts"), "utf8");
    for (const port of ["projects", "artifacts", "surfaces", "runs", "fidelity", "blobs", "queue", "toolchain", "audit", "clock"]) {
      expect(source).toContain(`${port}:`);
    }
  });
});

describe("only the toolchain adapter knows the compiler", () => {
  it("no other file imports @fanos/compile or @fanos/conform", () => {
    const importers = ALL.filter((f) =>
      importsOf(f).some((spec) => spec === "@fanos/compile" || spec === "@fanos/conform"),
    ).map((f) => relative(SRC, f));

    expect(importers).toEqual(["modules/runs/adapters/fanos-toolchain.ts"]);
  });
});
