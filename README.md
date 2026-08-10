# FanOS

Monorepo for the FanOS Figma-to-SDUI generation pipeline.

Before any generation work happens, we need a labeled corpus of what we have
already shipped. That is what lives here today.

## Packages

| Package                                                          | What it is                                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [`@fanos/figma-ir-extractor`](packages/figma-ir-extractor) | Figma plugin: walks a page frame → Frame IR JSON + section PNGs. |
| [`@fanos/tokens`](packages/tokens) | Token compiler: raw theme export → normalized vocabulary, lint, CSS + TS types + Tailwind. |
| [`@fanos/dsl`](packages/dsl) | SDUI vocabulary: 18 node types, flat wire format, validator, agent JSON Schema. |
| [`@fanos/renderer`](packages/renderer) | Web SDUI renderer (7 nodes) + Playwright pixel-diff harness. |

Together `@fanos/tokens` and `@fanos/dsl` are **T0, the canonical registry**:
tokens owns names and values, the DSL owns node shapes and consumes those tokens
as types. `@fanos/renderer` is the first package that produces a pixel and the
acceptance harness for everything downstream (`generate → render → diff`).
Nothing downstream hand-maintains either — the extractor resolves Figma's
original variable names through the tokens name map, renderers read the emitted
CSS and `.d.ts`, and the codegen agent is handed a JSON Schema whose token enums
are closed over the tenant's real palette.

## Setup

```bash
pnpm install
```

Requires Node 22+ and pnpm 10.

## Common tasks

```bash
pnpm build       # build every package
pnpm test        # run every package's tests
pnpm typecheck   # tsc --noEmit across the workspace
pnpm clean       # drop build output
```

Scope to one package with `pnpm --filter @fanos/figma-ir-extractor <script>`.

## Layout

```
packages/
  figma-ir-extractor/
    manifest.json          Figma plugin manifest (api 1.0.0, no network access)
    esbuild.mjs            two bundles: sandbox code + self-contained UI html
    src/
      code.ts              sandbox: traversal, normalization, export
      ui.html / ui.ts      button, progress line, summary, file downloads
      ir/schema.ts         Zod schema + inferred types (source of truth)
      ir/signature.ts      strict + canonical signatures, repeatedSiblings (pure)
      zip.ts               store-only ZIP writer, so N files save in one click
    tests/                 signature + zip tests, plain fixtures, no Figma needed
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
  renderer/
    fixtures/              player-card.data.json
    public/                self-hosted fonts + local assets
    src/
      resolve/             style + anchor + data (pure)
      components/          Box, Stack, Overlay, Text, Image, Icon, Divider
      harness/             renderToPng, diff, mapRegionsToNodes
      cli.ts               fos-render png | diff | report
    tests/                 148+ tests, incl. exhaustive anchor table
tsconfig.base.json         shared compiler options
```

New packages go under `packages/*` and are picked up by `pnpm-workspace.yaml`
automatically. Add `build`, `test`, `typecheck` and `clean` scripts so the root
scripts keep working.
