# FanOS

Monorepo for the FanOS Figma-to-SDUI generation pipeline.

Before any generation work happens, we need a labeled corpus of what we have
already shipped. That is what lives here today.

## Apps

| App | What it is |
| --- | --- |
| [`@fanos/surface-studio`](apps/surface-studio) | Page board. Listens on `:3000` for **Send to Surface Studio** from the plugin. |
| [`@fanos/api`](apps/api) | Control plane on `:4000`. Artifact store, surface versioning, pipeline runs, fidelity gate. Postgres + Redis. |
| [`@fanos/web`](apps/web) | Client-facing site on `:3415`. Next.js 15. Owns routing, data fetching and streaming; renders through the `@fanos/renderer` SDK. |

## Packages

| Package                                                          | What it is                                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [`@fanos/surface-canvas`](packages/surface-canvas) | **FanOS Surface Canvas** — Figma plugin: Health, Layout, and send to Surface Studio (ZIP is the escape hatch). |
| [`@fanos/tokens`](packages/tokens) | Token compiler: raw theme export → normalized vocabulary, lint, CSS + TS types + Tailwind. |
| [`@fanos/dsl`](packages/dsl) | SDUI vocabulary: 18 node types, flat wire format, validator, agent JSON Schema. |
| [`@fanos/renderer`](packages/renderer) | **The rendering SDK.** 7 node types as React Server Components + pure resolvers. Framework-free. `@fanos/renderer/harness` adds the Playwright pixel-diff rig. |

Together `@fanos/tokens` and `@fanos/dsl` are **T0, the canonical registry**:
tokens owns names and values, the DSL owns node shapes and consumes those tokens
as types. `@fanos/renderer` is the first package that produces a pixel and the
acceptance harness for everything downstream (`generate → render → diff`).
Nothing downstream hand-maintains either — the extractor resolves Figma's
original variable names through the tokens name map, renderers read the emitted
CSS and `.d.ts`, and the codegen agent is handed a JSON Schema whose token enums
are closed over the tenant's real palette.

`@fanos/surface-canvas` is the in-Figma front of the pipeline. **Surface Studio**
is the page board it sends to. Health exists because token binding coverage is
the ceiling on everything after it: a generator cannot emit token-referencing
SDUI for regions with no tokens behind them.

## Setup

```bash
pnpm install
```

Requires Node 22+ and pnpm 10.

## Common tasks

```bash
pnpm dev         # studio :3000, web :3415, api :4000, and the worker
pnpm build       # build every package
pnpm test        # run every package's tests
pnpm typecheck   # tsc --noEmit across the workspace
pnpm clean       # drop build output
```

Start one process with `pnpm dev:studio`, `pnpm dev:web`, `pnpm dev:api`, or `pnpm dev:worker`.

Scope to one package with `pnpm --filter @fanos/surface-canvas <script>`.

## Layout

```
packages/
  surface-canvas/
    manifest.json          Figma plugin manifest (api 1.0.0, no network access)
    esbuild.mjs            two bundles: sandbox code + self-contained UI html
    src/
      main.ts              sandbox: session, dispatch, incremental re-lint
      traverse.ts          Figma nodes -> Frame IR (the only reader)
      export.ts            Export tab: IR + section screenshots
      reconcile.ts         token <-> Figma variable/style map, with a value check
      fix.ts               bulk apply, one undo step per batch
      heatmap.ts           canvas overlay, removed on close
      health/              slots, coverage, batching, report shapes (pure)
      rules/               B1-B3 blockers, F1-F7 fixable, W1 warn (pure)
      match/               colour ΔE, numeric scale, type quadruple (pure)
      ir/schema.ts         Zod schema + inferred types (source of truth)
      ir/signature.ts      strict + canonical signatures, repeatedSiblings (pure)
      ui/                  React 19 panel: coverage bar, fix queue, blockers
      zip.ts               store-only ZIP writer, so N files save in one click
    tests/                 200 tests, plain node, no Figma — incl. a purity gate
  tokens/
    fixtures/              raw theme exports, keyed by theme UUID
    surfaces/              composite surfaces, authored per theme
    src/
      normalize.ts         raw ↔ canonical naming, name map (pure)
      validate.ts          the linter: E1-E7, W1-W6, I1 (pure)
      emit/                CSS, TypeScript unions, Tailwind v4/v3
      registry.ts          has/resolve/list/search/describe for agent tool use
      cli.ts               fos-tokens build | check | types | tailwind
    tests/                 164 tests, incl. every expected finding on the export
  dsl/
    fixtures/              flat SDUI trees (player-card.json)
    src/
      field.ts             one prop declaration -> Zod, JSON Schema, TS, docs
      flat.ts              flatten / reify, the flat wire format (pure)
      nodes/               8 structural + 10 leaf node declarations
      validate.ts          S1-S12, T1-T5, quality metrics (pure)
      ops.ts               tree ops for the repair loop (pure)
      emit/                .d.ts, agent JSON Schema, docs
      cli.ts               fos-dsl check | types | schema | docs
    tests/                 129 tests, incl. every acceptance mutation
  renderer/                the SDK — no Next, no framework
    fixtures/              *.data.json, read by the tests and by apps/web
    public/                self-hosted fonts + local assets (apps/web symlinks it)
    src/
      index.ts             the SDK entry: resolvers + components
      harness.ts           `@fanos/renderer/harness` — Playwright, kept off the SDK entry
      resolve/             style + anchor + data (pure)
      components/          Box, Stack, Overlay, Text, Image, Icon, Divider
      harness/             renderToPng, diff, mapRegionsToNodes
      cli.ts               fos-render png | boxes | diff | report
    tests/                 168 tests, incl. exhaustive anchor table
apps/
  web/                     the client-facing site
    app/                   Next routes. page.tsx + render/ are the fixture board
    public ->              symlink to packages/renderer/public (one copy of the bytes)
    next.config.ts         transpiles @fanos/renderer, @fanos/dsl, @fanos/tokens
  api/
    docker-compose.yml     postgres (host :5433) + redis
    drizzle/               generated migration SQL
    src/
      index.ts             HTTP process
      worker.ts            queue worker process
      context.ts           composition root — the only place adapters are chosen
      kernel/              errors, hashing, clock, audit port — no infrastructure
      modules/<name>/      domain/ (rules + ports), app/ (use cases), adapters/
      platform/            db schema + pool, http server, system clock
    tests/                 147 unit tests over in-memory adapters, incl. an
                           architecture gate; 13 integration tests vs Postgres
tsconfig.base.json         shared compiler options
```

New packages go under `packages/*` and are picked up by `pnpm-workspace.yaml`
automatically. Add `build`, `test`, `typecheck` and `clean` scripts so the root
scripts keep working.
