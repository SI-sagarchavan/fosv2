# @fanos/surface-canvas

**FanOS Surface Canvas** — the Figma plugin. Three tabs:

| Tab        | What it does                                                                              |
| ---------- | ----------------------------------------------------------------------------------------- |
| **Health** | Measures token binding coverage, ranks the loose values into batches, and fixes them in bulk. |
| **Layout** | The sizing contract: hug pinned text so bound copy can grow the box.                      |
| **Export** | Walks a frame into Frame IR + section PNGs and **sends** them to Surface Studio. The ZIP is the local escape hatch. |

This package was `@fanos/figma-ir-extractor` through v0.1. It is renamed because
it stopped being one tool: extraction is now one capability among several that a
designer-facing surface in Figma needs to carry, and the next things that belong
here (sections, preview) are not extraction either. The IR library entry is
unchanged — `@fanos/surface-canvas/ir` exports exactly what
`@fanos/figma-ir-extractor/ir` did, and `@fanos/conform` and `@fanos/compile`
import it the same way.

## The point of the Health tab

Token binding coverage is the ceiling on everything downstream. A generator
cannot emit token-referencing SDUI for regions with no tokens behind them, and on
the reference file that number is 53.9%.

The tab exists to move it, and the design principle governing every decision in
it is: **the plugin pays the designer before it asks them for anything.** It is
not a linter that serves the pipeline. It fixes 300 layers in one click, and
collects signal as a side effect. Concretely:

- The hero is the fix queue, not the score. A big percentage tells a designer
  they are failing; a ranked list of levers with payoffs tells them what to do.
- Copy names consequences, never conventions. "Hardcoded white can't respond to a
  theme swap", never "fills must be bound to variables".
- Safe and unsafe batches look different, and no near match is ever applied
  unattended.

## Architecture — the decision that matters most

**Lint runs on Frame IR, never on Figma nodes.**

```
  traverse (traverse.ts)  ->  IR  ->  rules (pure)  ->  findings  ->  batches
                                          |
                                    fixes (fix.ts, Figma-specific)
```

Consequences, all of which the code preserves:

- the same rule engine runs in-plugin and later in CI as a handoff gate
- rules are pure functions, testable against IR fixtures with no Figma
- a rule change is a diff you can replay across the whole corpus
- the only Figma-specific code is `traverse -> IR`, `reconcile`, `applyFix`, and
  the heatmap

`tests/purity.test.ts` enforces it: every file under `src/health/`, `src/rules/`
and `src/match/` is checked for `@figma/*` imports, the `figma` global, and
sandbox-only types. Those tests run in plain node.

```
src/
  main.ts          sandbox entry: session, dispatch, debounce, incremental re-lint
  traverse.ts      Figma nodes -> Frame IR                          (figma-aware)
  export.ts        the Export tab: IR + screenshots                 (figma-aware)
  reconcile.ts     token <-> Figma variable/style map               (figma-aware)
  fix.ts           apply proposals, undo checkpointing              (figma-aware)
  heatmap.ts       overlay lifecycle                                (figma-aware)
  themes.ts        the themes compiled into the bundle
  protocol.ts      the sandbox <-> iframe message contract          PURE
  health/
    types.ts       the vocabulary: Finding, Proposal, ThemeSnapshot PURE
    slots.ts       what "a thing that can be bound" means           PURE
    coverage.ts    the score                                        PURE
    batch.ts       findings -> batches                              PURE
    sizing.ts      hug / fill / fixed + pinned text                 PURE
    activity.ts    who bound what — per-designer lanes, merged      PURE
    reconcile-report.ts                                             PURE
    index.ts       the `./health` library entry                     PURE
  rules/           one file per rule, B1-B3 / F1-F7 / W1            PURE
  match/           color (ΔE), number (scale), type (quadruple)     PURE
  ui/              React 19 panel
```

## Coverage is derived from the queue, not counted beside it

`slots.ts` is the single definition of a bindable slot. The score and the fix
queue are both computed from it, so the bar cannot promise a gain the queue
cannot deliver — `tests/acceptance.test.ts` asserts the two agree. The one
subtlety worth knowing:

| Slot                  | Counted when              | Bound when                        |
| --------------------- | ------------------------- | --------------------------------- |
| fill, stroke, text, effect | present               | the IR found a variable or style  |
| radius                | always, **including zero** | a variable is bound               |
| gap, padding          | **non-zero only**          | a variable is bound               |

The zero asymmetry is deliberate. `radius.none` exists in the theme, so a bound
zero radius is a decision that survives generation while a loose zero is
indistinguishable from nobody having thought about it. Zero spacing is not a
hardcoded value; it is the absence of one. This is the single place the
denominator differs from `countBindings()` in `export.ts`, which skips zero
radius — so the Export tab's "unbound %" and the Health tab's coverage will not
be identical on the same page, by design.

## The rules

Every rule declares the downstream failure it prevents. If it cannot, it does not
belong in the array.

### Blockers — no autofix, generation cannot proceed

| Rule                        | Protects                     | Action |
| --------------------------- | ---------------------------- | ------ |
| **B1** root-not-autolayout  | segmentation                 | none — wrapping reflows the frame |
| **B2** groups-instead-of-frames | responsive layout        | Convert groups to frames |
| **B3** no-mobile-frames     | responsive prop derivation   | none — needs a mobile artboard |

B2's layer count is over **distinct** descendants. Nested groups would otherwise
be counted once per ancestor, and a number that overstates the problem is still
wrong when the designer counts the layers themselves.

### Fixable — the product

| Rule                     | Matching                                                                 |
| ------------------------ | ------------------------------------------------------------------------ |
| **F1** unbound-fill      | exact hex, else ΔE candidates. Gradients grouped, no proposal.            |
| **F2** unbound-stroke    | same                                                                     |
| **F3** unbound-text-style| the full quadruple at the current breakpoint. **Exact only.**             |
| **F4** unbound-spacing   | itemSpacing + four paddings, zero skipped                                 |
| **F5** unbound-radius    | includes zero                                                             |
| **F6** unbound-effect    | reports, does not propose — see below                                    |


**F6 proposes when the IR has geometry (1.2.0).** Exact match only, against
`theme.shadows`, applied as an effect style — the same shape as F3. A 1.1.0 row
with no `{ x, y, blur, spread, color, opacity }` still reports and does not
propose: guessing from `DROP_SHADOW` alone would bind every shadow on the page
to whichever token happens to exist. LAYER_BLUR / BACKGROUND_BLUR have no
elevation token and stay report-only.

### Warn

**W1** default-layer-names, reported as a percentage **excluding VECTOR nodes**.
Vectors are ~44% of a real file and their names are meaningless by nature;
counting them puts the number in the seventies and makes it unactionable.

## Reconciliation, and the value check

Before any rule can propose anything, `reconcile.ts` asks the file what actually
exists. It checks three things, in increasing order of how badly each one bites:

1. **does a variable with this name exist** — matched on the leaf name, tolerant
   of `/` grouping, so `spacing_4` finds `spacing_4`, `spacing/spacing_4` or
   `Spacing/spacing_4`, plus a separator-free fallback
2. **is it the right resolved type** — a COLOR for a colour, a FLOAT for a number
3. **does it hold the value the theme says it does**

(3) is the one that matters most and the easiest to skip. A file where
`spacing_4` holds 20 while the theme says 16 would turn "bind 60 layers" into
"silently re-space 60 layers", and the designer would find out from a diff. A
mismatch therefore makes the token **unbindable**, with both numbers in the
reason, and the panel lists those separately and first.

A token with no variable is surfaced and its batch is disabled with the reason
attached. It is never offered as a button that fails.

**Library variables bind.** Reconciliation reads local collections, variables
the page already uses, and enabled published libraries (by key). Import happens
at apply time, never while checking. A file with zero local collections and a
healthy library count is the normal shape for a design-system consumer.

## The ΔE threshold

Colour near-matching ships as **CIE76 (Euclidean CIELAB) at ΔE < 13**, scoped to
the nearest token family, deduped by hex, capped at 3 candidates. Both CIE76 and
CIEDE2000 are implemented and the metric is a `LintOptions` field.

The threshold is 13 rather than the textbook 10, and the reasoning is measured
rather than asserted. Against the reference palette:

| Loose value | CIE76 nearest                                  | CIEDE2000 nearest                |
| ----------- | ---------------------------------------------- | -------------------------------- |
| `#ffffff`   | `core_neu_00` at 0 (exact; 9 tokens share it)   | same                             |
| `#ff4b32`   | `core_prim_400` **10.98**, `core_prim_500` 12.66 | `core_error_400` 6.70, `core_prim_400` 6.94 |
| `#000000`   | `core_neu_950` 9.26, `core_neu_900` **12.70**   | `core_neu_950` 5.52, `core_neu_900` 7.72 |

- At **CIE76 < 10** the brand red gets nothing at all — 36 layers with no lever —
  even though ΔE76 10.98 is ΔE00 6.94, unmistakably the same red. CIE76's known
  weakness is saturated reds, which is exactly where the reference file's brand
  colour sits.
- At **CIEDE2000 < 10** the nearest family becomes `core_error`, so a brand red is
  offered error reds. Numerically closer, semantically wrong.
- **CIE76 < 13** gives the brand red its two primaries, which is what the build
  spec expected.

### Where this deviates from the build spec

The spec predicted `#ff4b32 -> 2 near candidates` and `#000000 -> 1`. The first
holds. **The second does not: `#000000` reports two candidates** (`core_neu_950`
at 9.26 and `core_neu_900` at 12.70).

Both cannot hold at once under any defensible rule. Satisfying them together
requires a threshold above 12.66 and below 12.70 — a 0.04 ΔE window, a number
chosen to pass a test rather than to describe perception.
`tests/match-color.test.ts` pins that arithmetic so the decision stays auditable.
Two candidates is also the better answer here: `#1a1a1a` and `#212121` are both
legitimate choices for a black layer, and neither is bulk-applicable either way.

Family scoping is the other departure worth naming. The spec says "candidates
sorted by ΔE"; this implementation first picks the nearest family and only then
sorts within it. Offering a designer an *error* red for a *brand* red is a
semantic mistake dressed up as a measurement, and it is the difference between
the spec's expected `core_prim_400/500` and a mixed list.

## Bulk apply is one undo step

Figma does not commit plugin actions to undo history on its own; an undo group is
everything between two `figma.commitUndo()` calls. So `fix.ts`:

1. resolves every node, variable and font in an **async prepare phase**
2. calls `commitUndo()` to close off whatever came before
3. runs the mutations with no `commitUndo()` between them, ever
4. calls `commitUndo()` again to seal the batch

Fill and spacing fixes are fully synchronous in step 3
(`setBoundVariableForPaint` + reassignment, `setBoundVariable`). Text-style fixes
have to use `setTextStyleIdAsync` because the manifest declares
`documentAccess: dynamic-page`; fonts are preloaded in step 1 so the awaits are
the only thing between mutations.

Two more guarantees in there:

- **Nothing unattended that isn't exact.** `applyBatch` refuses a batch that is
  not exact-and-bindable. A near match only moves through `applyCandidate`, which
  requires the designer to have named the token they picked.
- **No writes against a stale report.** Every item is re-read before it is
  written and skipped if the value the batch was built from has changed. A report
  is a photograph; the file kept moving after it was taken.

### The undo behaviour has NOT been verified in a running Figma

This cannot be asserted from a test — it needs a human, a real file, and one
Ctrl-Z. The protocol, to run before this goes near a client file:

1. Open the reference file, run FanOS Surface Canvas, wait for the report.
2. Note the coverage number. Click **Bind 110** on the `#ffffff` batch.
3. Press Ctrl/Cmd-Z **once**.
4. **Pass:** all 110 fills are loose again and coverage is back to its original
   value. **Fail:** anything less than all 110 reverts.
5. Repeat for the `gap 10` batch (78 layers, `setBoundVariable`) and for a
   text-style batch (the async path, the one most likely to break).
6. Record the result — and the Figma build number — in this section.

**Result: not yet run.** If step 4 fails on the async text path, the fix is to
split text batches into their own undo group per batch and say so in the UI, not
to widen the group.

## Performance

- traversal yields to the event loop every 500 nodes
- `nodechange` on the current page, debounced 400ms. Not `documentchange`: under
  `documentAccess: dynamic-page` that event requires `loadAllPagesAsync()` first,
  which means loading every page in the file before the panel can do anything.
  The page-scoped event is what this plugin wants anyway, and switching pages
  re-binds it and re-lints.
- incremental re-lint re-walks only the subtrees named in the change event, then
  re-runs the pure pass over the patched tree. Full re-walk only on explicit
  refresh. Page-level rules stay correct because the pure pass is whole-tree and
  cheap — the Figma reads are what cost.
- variables, styles and resolved names cached in Maps for the session
- `enumerateSlots` memoized per root, so eight rules share one walk

Measured: the pure pass over the 1,596-node reference shape is single-digit
milliseconds (`tests/acceptance.test.ts` budgets 3s and passes with room to
spare). The Figma-side traversal is unmeasured here for the same reason the undo
behaviour is — it needs the real file.

## The heatmap

One locked top-level frame named `__fos_heatmap__`, one semi-transparent rect per
node: green bound, red loose, amber inside a blocker. Cleanup is defensive to the
point of paranoia — `figma.on("close")` removes it, and a startup sweep removes
any frame with that name including one orphaned by a session that crashed. A
heatmap left behind in a client file is the fastest way to lose trust in the tool.

## Themes

Every theme the plugin can check against is compiled in at build time. Adding a
tenant is two lines in `src/themes.ts` — an import and a `THEME_FILES` entry —
and a rebuild. Switching themes in the header re-runs reconciliation and
re-proposes every batch. Network access is **not** used to load themes.

The manifest allows `http://localhost:3000` so the sandbox can post page
exports to a local Surface Studio. Figma rejects `127.0.0.1` in
`allowedDomains` — use `localhost`. The client lives in `src/api/`, is Figma-free, and never blocks a lint.
**Send to Surface Studio** (`POST /v1/exports`) is the production path — the
same IR + PNGs the ZIP would have held. **Export locally / Save ZIP** stays as
the escape hatch when the board is down. The origin is `http://localhost:3000`
unless `fanos-studio.api-origin` in clientStorage names the other loopback host.

`@fanos/tokens` ships as one bundled ESM file and one module in it imports
`node:fs` for `loadTheme()`. The plugin never calls it, but esbuild resolves
imports while parsing, so `esbuild.mjs` maps node builtins to a stub that
**throws** — if anything in the sandbox ever does reach for the filesystem, that
should be a loud error at the call site.

## Install

```bash
pnpm --filter @fanos/surface-canvas build
```

Then in Figma: **Plugins → Development → Import plugin from manifest…** and pick
`packages/surface-canvas/manifest.json`.

`pnpm --filter @fanos/surface-canvas watch` rebuilds both bundles on change.

## Tests

```bash
pnpm --filter @fanos/surface-canvas test
```

200 tests, all in plain node, no Figma.

`tests/southern-brave-shape.ts` builds a synthetic 1,596-node page with the
distribution the build spec recorded from the real file, and
`tests/acceptance.test.ts` asserts the engine turns it into the documented report
— 53.9% coverage, three blockers with their counts, the seven batches in order,
321 slots safe at +12.9%.

**What that does and does not prove.** It proves the engine's arithmetic and
verdicts. It does not prove the real file still has that distribution — only
running the plugin against the file establishes that, and these numbers are the
prediction to check it against.

## Not built, deliberately

Sections, section markers, `sharedPluginData`, annotations, `dataRef`, contracts,
preview, rendering, Health/bind event emission, edge docking, component
suggestions, auth, tenancy, CI wiring. The HTTP client is in place; it does not
fire yet. The rules are reusable for the CI gate —
`import { lint } from "@fanos/surface-canvas/health"` — but nothing wires it up.

Health now also: proposes effect styles when geometry is
in the IR (F6), converts groups to frames (B2), and resets drifted *local*
variables to the theme. B1 never auto-wraps — that reflows overlays and menus.
Autofix is still exact binds only.
