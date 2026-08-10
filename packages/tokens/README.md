# @fanos/tokens

The canonical source of truth for design tokens. It ingests the raw theme JSON
exported from the design system, normalizes it into a stable vocabulary,
validates it, and emits CSS, TypeScript types and a Tailwind bridge.

Everything downstream derives from this package. Nothing may be hand-maintained
downstream — if a consumer needs a token, it is added here and regenerated.

```bash
pnpm --filter @fanos/tokens build
pnpm --filter @fanos/tokens test
```

## CLI

```bash
fos-tokens check    --theme fixtures/southern-brave.json --surfaces surfaces/southern-brave.json [--json]
fos-tokens build    --theme <f> --surfaces <f> --out <dir> [--scope root|attr]
fos-tokens types    --theme <f> --surfaces <f> --out <file>
fos-tokens tailwind --theme <f> --out <file> [--v3]
```

`check` exits non-zero when the token file has errors. `build` runs the same
check first and refuses to emit while it fails — pass `--force` to override.
The theme file is keyed by UUID; `--theme-id` is only needed when it holds more
than one.

`build --out <dir>` writes `tokens.css`, `tokens.d.ts`, `tailwind.css` and a
`manifest.json` carrying a content hash per file.

## Part 1 — Normalization

Raw names embed their own category and sometimes a redundant suffix. The
canonical vocabulary strips both. The light/dark level becomes a theme scope
rather than part of the ref, and `typography_<bp>` becomes `type.*` with the
breakpoint turning into a media query.

| raw | canonical |
| --- | --- |
| `spacing.spacing_4` | `space.4` |
| `spacing.spacing_0_5` | `space.0_5` |
| `radius.radius_2xl` | `radius.2xl` |
| `radius.radius_rounded` | `radius.rounded` |
| `color.light.core_sec_500` | `color.core_sec_500` |
| `color.light.text_invert_high` | `color.text_invert_high` |
| `gradient.light.gradient_nue_vert_1_gradient` | `gradient.nue_vert_1` |
| `shadow.light.drop_shadow_md` | `shadow.md` |
| `opacity.opacity_40` | `opacity.40` |
| `typography_desktop.dp_2_regular` | `type.dp_2_regular` |

The rule is one line: split the leaf on `_`, find the category word as a whole
segment, keep everything after it, then drop a trailing `_gradient`. The word is
never consumed when it is the final segment, so a token named `foo_shadow` keeps
its name instead of normalizing to the empty string. `core_sec_500` contains no
`color` segment, so colour names pass through untouched — which is the point.
**The raw names are the contract with Figma and are never renamed.**

### The reverse direction matters as much

The Figma IR extractor reads `boundVariables` and gets ORIGINAL names, so it
needs to get back to a canonical ref.

```ts
toCanonical("color/light/core_sec_500")   // "color.core_sec_500"  (slash or dot)
toCanonical("core_sec_500", "color")      // "color.core_sec_500"  (bare leaf)
toRaw("shadow.md")                        // "drop_shadow_md"
theme.names.toCanonical("drop_shadow_md") // "shadow.md"  — data-backed, exact
```

`toCanonical` throws rather than guessing when a bare leaf's category is
unknowable (every colour and every type style look alike). A silently wrong ref
in a codegen pipeline is worse than a loud failure. `theme.names` is the
data-backed map built from the actual export and resolves those cases exactly.

`toRaw` is lossy in one place: `drop_shadow_md` and a hypothetical
`inner_shadow_md` both reduce to `shadow.md`, so the standalone function assumes
`drop_`. The day an inner shadow is added, the theme's name map stops being
bidirectional and **E7** fails the build rather than letting one silently win.

`toCanonical(toRaw(x)) === x` is asserted for all 263 tokens in the fixture.

## Part 2 — Surfaces

The raw file has colour, gradient, radius and shadow as separate primitives with
no way to compose them. Surfaces add the composite layer, authored per theme in
`surfaces/<theme>.json` and referencing canonical refs.

```jsonc
{
  "assets": {
    "texture.stripes": "/assets/textures/stripes.png",
    "texture.noise": "/assets/textures/noise.png"
  },
  "surfaces": {
    "card_player": {
      "layers": [
        { "type": "gradient", "ref": "gradient.sec_vert_1" },
        { "type": "image", "ref": "asset.texture.stripes", "fit": "cover", "opacity": 30, "blend": "overlay" },
        { "type": "image", "ref": "asset.texture.noise", "opacity": 6, "blend": "overlay" }
      ],
      "borders": [
        { "width": 1, "color": "color.core_neu_00", "opacity": 20, "radius": "radius.2xl" },
        { "width": 1, "color": "color.core_neu_00", "opacity": 10, "inset": 8, "radius": "radius.xl" }
      ],
      "radius": "radius.2xl",
      "shadow": "shadow.md"
    }
  }
}
```

**Layers are ordered BOTTOM to TOP.** CSS `background-image` paints the
first-listed layer on TOP, so the array is reversed on emit. Get this wrong and
every textured surface renders inside-out; it is covered by a test that asserts
the emitted order is the exact reverse of the authored one.

At most one border may carry `inset` — it renders via `::before`, and a second
would need `::after`. Two is **E3**. A second *non-inset* border is fine: it
becomes an inset `box-shadow` ring, which is exact and composes with the shadow
token in the same declaration.

Every `ref` must resolve, including `asset.*`. That is why the file accepts the
wrapped `{ assets, surfaces }` form — asset URLs are not in the token export, so
without somewhere to declare them every image layer would be **E2**. The flat
`{ "card_player": … }` form is still accepted for surfaces that use no assets.

### Image layer opacity is not expressible in CSS

`background-image` layers have no per-layer opacity, and no blend mode takes an
alpha parameter. Colour and gradient layers are fine — their alpha is folded
straight into the emitted colour stops. For **image** layers the emitter writes
the URL, raises a build warning, and exposes the value as
`--fos-surface-<name>-layer-<i>-opacity` so a renderer can honour it
deliberately. The two real options are a wrapper element per textured layer, or
baking the alpha into the asset. Neither is this package's call to make.

## Part 3 — Validation

`check` lints and reports; it never silently fixes.

### Errors — non-zero exit

| code | rule |
| --- | --- |
| E1 | a `type.*` key is missing on some breakpoint |
| E2 | a surface references a token that does not resolve |
| E3 | two inset borders on one surface |
| E4 | gradient stops move backwards, or a percent is outside 0–100 |
| E5 | malformed hex, negative length, opacity outside 0–100 |
| E6 | two steps of one `core_<family>` ramp share a value |
| E7 | two raw names normalize to the same canonical ref |

**E1** is the one that matters most. A tree referencing `type.xl_medium`
resolves on mobile and tablet and fails on desktop, and no type system
downstream can catch it — which is why the generated `TypeToken` union is built
from the intersection, not the union.

**E6** is not the same thing as an alias. Aliasing across families
(`text_invert_high` pointing at `core_neu_00`'s white) is the entire point of a
semantic layer and is reported as informational **I1**. Two steps of the *same*
ramp holding one value is different: a designer picking 600 over 500 expressed
intent that the file then threw away.

### Warnings — reported, build continues

| code | rule |
| --- | --- |
| W1 | near-duplicate names — separators collapsed before comparing |
| W2 | shadow at 100% opacity: an opaque offset box, not an ambient shadow |
| W3 | typography weight disagrees with its name suffix (`regular`=400, `medium`=500, `bold`=700) |
| W4 | category present but empty |
| W5 | `letter_spacing` is 0 on every style — reported ONCE in aggregate |
| W6 | 3+ consecutive gradient stops at one percent; coalesced on emit |
| I1 | alias density, reported once as a ratio |

W1 collapses separators but keeps one between two digits, so `spacing_1_5` is not
fused into `spacing_15` — those are different real tokens. It is the same
digit-neighbour rule that keeps `--fos-space-0_5` underscored.

W5 is aggregated deliberately. Ninety-five identical lines would bury every
other finding, and the actionable fact is the single one: tracking was never
authored.

### What the current export reports

`fos-tokens check` on `fixtures/southern-brave.json` exits **1** with exactly two
error classes:

```
E1  type.h3_medium   present=[desktop]         missing=[mobile, tablet]
    type.xl_medium   present=[mobile, tablet]  missing=[desktop]
    type.xl_regular  present=[mobile, tablet]  missing=[desktop]
E6  core_sec_500 == core_sec_600 == #2939a3
```

plus 1×W1 (`background_sec_card2` / `background_sec_card_2`), 5×W2 (every drop
shadow is `#1a1a1a` at 100%), 4×W3, 5×W4 (`badge.size`, `button.size`,
`color.dark`, `gradient.dark`, `shadow.dark`), 1×W5 and the I1 line
`163 -> 61`. Every one of those numbers is locked in by
`tests/fixture.test.ts`.

Key counts: mobile 32, tablet 32, desktop 31; union 33, intersection 30.

## Part 4 — CSS emission

Prefix `--fos-`. Dots and underscores become dashes.

```css
--fos-space-4: 16px;
--fos-space-0_5: 2px;
--fos-radius-2xl: 24px;
--fos-radius-rounded: 999px;
--fos-color-core-sec-500: #2939a3;
--fos-color-core-sec-500-rgb: 41 57 163;
--fos-opacity-40: 0.4;
--fos-gradient-nue-vert-1: linear-gradient(180deg, rgb(26 26 26 / 0%) 20%, rgb(26 26 26 / 100%) 100%);
--fos-shadow-md: 3px 3px 4px 0px rgb(26 26 26 / 100%);
```

### The `-rgb` triplet is mandatory

Every colour emits both a hex var and a space-separated `r g b` var. The token
file has no alpha variants, so surfaces composite with
`rgb(var(--fos-color-core-neu-00-rgb) / 20%)`. Without the triplet, alpha
compositing is impossible. A test walks all 163 colours and asserts both exist.

### Half-step spacing keeps its underscore

`space.0_5` emits `--fos-space-0_5`, not `--fos-space-0-5`, which would be
indistinguishable from a hypothetical `space.0-5`. The rule generalises: an
underscore becomes a dash unless it sits between two digits. Every other
underscore in the vocabulary is next to a letter and dashes normally
(`core_sec_500` → `core-sec-500`).

Class names are the exception and keep the leaf verbatim —
`.fos-type-dp_2_regular`, `.fos-surface-card_player`. Authors type these by hand
and match them against the keys they wrote.

### Gradient degree: Figma and CSS agree

**Finding: no conversion is needed.** Both systems measure from the same origin
in the same direction — 180 means top-to-bottom in each. Verified against
`gradient_nue_vert_1`, authored at degree 180 with 0% opacity at the 20% stop and
100% at the 100% stop, which renders top-transparent / bottom-dark in Figma and
does the same under `linear-gradient(180deg, …)`. The degree is carried through
verbatim. If a future export disagrees, `formatGradient` in `src/emit/css.ts` is
the one line to change.

Shadow `type: "inner"` emits the CSS `inset` keyword; `"drop"` emits nothing.

### Typography

Five vars per style plus a utility class, redefined per breakpoint, mobile-first:

```css
:root {
  --fos-type-dp-2-regular-size: 36px;
  --fos-type-dp-2-regular-weight: 400;
  --fos-type-dp-2-regular-family: "Bakbak One";
  --fos-type-dp-2-regular-leading: 40px;
  --fos-type-dp-2-regular-tracking: 0em;
}
@media (min-width: 768px)  { :root { /* tablet */ } }
@media (min-width: 1280px) { :root { /* desktop */ } }

.fos-type-dp_2_regular {
  font-family: var(--fos-type-dp-2-regular-family);
  font-size: var(--fos-type-dp-2-regular-size);
  font-weight: var(--fos-type-dp-2-regular-weight);
  line-height: var(--fos-type-dp-2-regular-leading);
  letter-spacing: var(--fos-type-dp-2-regular-tracking);
}
```

Only the vars that actually *change* at a breakpoint are re-declared — the
cascade carries the rest. Re-emitting all five fields for all 30 styles at every
breakpoint triples the file for no effect.

Breakpoints are not in the token file. They come from package config
(`{ md: 768, lg: 1280 }` by default, overridable with `--md` / `--lg`) and are
emitted as `--fos-bp-md` / `--fos-bp-lg` for JS consumers, since CSS media
queries cannot read a custom property.

Only styles in the **intersection** of the three breakpoints are emitted — 30 of
33. `--allow-partial-typography` emits all 33, falling back to the nearest
smaller breakpoint and warning per style; a style with nothing smaller
(`h3_medium` is desktop-only) reaches upward instead, and says so. Strict is the
default because the generated `TypeToken` union has to be safe at every viewport.

### Theme scoping and determinism

`--scope root` emits `:root`; `--scope attr` emits
`[data-fos-theme="style-southern-brave"]`. When a theme has a non-empty `dark`
palette, its overrides land under `[data-fos-scheme="dark"]` — currently empty
everywhere, so nothing is emitted.

Output is byte-deterministic: every map is walked through a locale-independent
natural-order comparator (never `localeCompare`, whose result depends on the ICU
build), nothing reads the clock, and no value is formatted with a
locale-sensitive API. Two consecutive builds are asserted byte-identical, as is
emission from two differently-ordered inputs.

## Part 5 — TypeScript emission

```ts
export type SpaceToken    = "space.0" | "space.0_5" | … ;  // 21
export type RadiusToken   = …                              // 8
export type ColorToken    = …                              // 163
export type OpacityToken  = …                              // 11
export type GradientToken = …                              // 22
export type ShadowToken   = …                              // 5
export type TypeToken     = …                              // 30 — the intersection
export type SurfaceToken  = …
export type AnyToken      = …
```

Type aliases only, which makes the output valid as either a `.ts` module or a
`.d.ts`; a test compiles it under `strict`. Runtime arrays of the same refs come
from `createRegistry(theme).list(category)`, so nothing is duplicated as a value.

This is what the DSL node schemas and the codegen agent's JSON Schema derive
from. If a ref is not in one of these unions, no downstream consumer can emit it.

## Part 6 — Runtime registry

```ts
const registry = createRegistry(theme, { surfaces });

registry.has("color.core_sec_500");     // true
registry.resolve("space.4");            // { category: "space", px: 16 }
registry.list("radius");                // ["radius.2xl", "radius.lg", …]
registry.search("coresec500");          // ["color.core_sec_500", …]  — max 20
registry.cssVar("space.0_5");           // "var(--fos-space-0_5)"
registry.describe("shadow.md");
// { ref: "shadow.md", category: "shadow", raw: "drop_shadow_md",
//   value: "3 3 4 0 #1a1a1a@100%", cssVar: "var(--fos-shadow-md)" }
```

`search` and `describe` exist so the codegen agent queries tokens as a **tool**
rather than carrying 163 colours in its context. Search ignores punctuation, so
`sec500`, `sec-500` and `sec_500` all find `color.core_sec_500` — an agent should
not have to guess separators. Results are capped at 20 and every response is one
short line.

`list("type")` and `has("type.…")` only admit the breakpoint-complete styles, for
the same reason `TypeToken` does.

## Part 7 — Tailwind

`fos-tokens tailwind` emits a v4 `@theme` block that maps our vocabulary onto
Tailwind's namespaces, so `bg-core-sec-500`, `p-4`, `rounded-2xl`, `shadow-md`
and `text-dp_2_regular` resolve to our tokens:

```css
@theme {
  --color-core-sec-500: var(--fos-color-core-sec-500);
  --spacing-4: var(--fos-space-4);
  --radius-2xl: var(--fos-radius-2xl);
  --text-dp_2_regular: var(--fos-type-dp-2-regular-size);
  --text-dp_2_regular--line-height: var(--fos-type-dp-2-regular-leading);
}
```

Every value **references** a `--fos-*` var and never duplicates it — a copied
literal is a second source of truth that rots the first time someone edits the
theme and rebuilds only the CSS. A test asserts no hex or px literal appears in
the output. Load `tokens.css` before `tailwind.css`.

Gradients have no Tailwind namespace and are exposed under a custom
`--gradient-*` so they are reachable as `bg-(--gradient-sec-vert-1)` rather than
lost.

`--v3` emits a JS preset instead, with colours as
`rgb(var(--fos-color-x-rgb) / <alpha-value>)` so `bg-core-sec-500/20` works. The
installed Tailwind major is read from the nearest `package.json` and a mismatch
warns.

## Architecture

```
src/
  types.ts        domain vocabulary
  normalize.ts    Part 1 — naming rules, name map, theme normalization   PURE
  validate.ts     Part 3 — the linter                                    PURE
  refs.ts         ref parsing, resolution, CSS naming                    PURE
  color.ts        hex/rgb                                                PURE
  gradient.ts     stop runs, coalescing, ordering                        PURE
  report.ts       human + JSON report rendering                          PURE
  config.ts       breakpoints, scope                                     PURE
  raw-schema.ts   Zod schemas for both authored inputs
  registry.ts     Part 6
  emit/css.ts     Part 4
  emit/types.ts   Part 5
  emit/tailwind.ts
  load.ts         the ONLY module that touches the filesystem
  cli.ts, bin.ts  Part 7
```

`normalize.ts` and `validate.ts` are pure, and `tests/purity.test.ts` enforces it
two ways: it greps their imports for anything `node:`, `process.`, `Date.now` or
`Math.random`, and it runs both end to end against in-memory objects.

The Zod schemas are **structural only**. They reject a file of the wrong shape;
they do not reject a malformed hex or a negative spacing value. Those are lint
findings with names and enough context to fix, and a Zod parse error would
collapse them into an unhelpful path string.

## Tests

```bash
pnpm --filter @fanos/tokens test
pnpm --filter @fanos/tokens typecheck
```

164 tests. The ones worth knowing about:

- the ten normalization pairs above, asserted literally as the contract
- `toCanonical(toRaw(x)) === x` across all 263 tokens in the fixture
- every expected finding on the real export, by count and by content
- the same fixture with E1 and E6 patched: exits zero, warning profile unchanged
- a three-layer surface asserting `background-image` is the exact reverse of the
  authored array, and `::before` carrying `inset: 8px`
- a synthetic gradient with stops 20,100,100,100,100 raising W6 and coalescing
- a synthetic gradient with stops 0,60,30 raising E4
- two consecutive builds byte-identical, and the generated `.d.ts` compiling
  under `strict`

## Known divergences from the spec

Two places where the implementation and the written spec disagree, both
deliberate and both flagged rather than silently resolved:

1. **W5 counts 95 type styles, not 96.** The export has 32 mobile + 32 tablet +
   31 desktop = 95, and all 95 have `letter_spacing: 0`.

2. **A run of stops coalesces to the run's first and last, which is not always
   two stops.** For the `gradient_nue_vert_1` shape in the fanxp-web-renderer
   export — percents 20,100,100,100,100 carrying opacities 0,100,25,25,25 — the
   run's first and last stop differ in opacity, so the result is three stops
   (20, 100, 100) rather than two. Only when the run's members are identical does
   it collapse to (20, 100). Both cases are covered by tests. If the intent was
   "always reduce a run to a single stop", it is a one-line change in
   `coalesceStops`.

Also worth knowing: the spec's surface example referenced
`gradient.prim_sec_vert_1`, which does not exist in this export — the gradients
are `prim_sec_horiz_1/2` and `sec_vert_1..6`. `surfaces/southern-brave.json` uses
`gradient.sec_vert_1` so the file validates clean.
