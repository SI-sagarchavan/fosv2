# @fanos/renderer

Web SDUI renderer and visual-diff harness for FanOS trees. The first package
that produces a pixel — and the acceptance gate for everything downstream:
`generate → render → diff`.

## Scope

Seven node types only: **Box, Stack, Overlay, Text, Image, Icon, Divider**.

Every component is a React Server Component. There is no `"use client"` in
this package.

## Stack

Next.js 15 App Router · React 19 · TypeScript strict · vitest · Playwright
(headless) · pixelmatch + pngjs · Node 22.

Depends on `@fanos/dsl` (node types, FlatTree, reify, validate) and
`@fanos/tokens` (CSS emission, registry, `resolveAsset`, motion scale).

```bash
pnpm --filter @fanos/renderer build
pnpm --filter @fanos/renderer test
# headless tests need Chromium once:
npx playwright install chromium
```

## Pure resolvers

| Function | Role |
| --- | --- |
| `resolveNode(props, ctx)` | Universal + Stack props → `{ className, style, dataAttrs }` |
| `resolveAnchor(place)` | 9 anchors × offsets → logical-property CSS |
| `interpolate(template, data)` | `{player.name}` → value; unresolved stays literal |

Token refs always become `var(--fos-…)`. Raw values emit literally and set
`data-fos-raw`. Negative tokens (`-space.6`) become `calc(-1 * var(…))`.
Percentages pass through and are not raw debt.

`size.w: "full"` on a flex child becomes `flex: 1 1 0` (equal thirds for the
stat strip), not `width: 100%`.

## Overlay structure

```
div.fos-overlay          position:relative; overflow:visible (or hidden if clip)
  div.fos-surface-layer  position:absolute; inset:0; z-index:0; overflow:hidden
  …children…             position:absolute per place.anchor; z-index:1; DOM order
```

Surface is a sibling, not a background on the Overlay. Radius + clipping live
on the surface layer; cutouts can bleed past the card top.

## Headless harness

```ts
const png = await renderToPng(tree, { data, themeCss, fontCss, width: 534 });
const { score, diffPng, regions } = diff(actual, expected);
const mapped = mapRegionsToNodes(regions, nodeBoxes, tree);
```

`regions` are bounding boxes of connected mismatch clusters. Combined with
`data-fos-id` boxes they are the bridge from pixels back to the tree for the
repair loop.

### CLI

```bash
fos-render png    --tree <f> --data <f> --theme <f> --out <f> [--width 534]
fos-render diff   --tree <f> --data <f> --theme <f> --expected <f> --out <dir>
fos-render report --tree <f> --data <f> --theme <f> --expected <f>
```

## Fonts

Bakbak One (400) and Montserrat (400/500/700) are self-hosted woff2 under
`public/fonts/` and preloaded. The harness waits on `document.fonts.ready`
before screenshotting. A silent fallback would make every text metric wrong.

## Fixture

`../dsl/fixtures/player-card.json` + `fixtures/player-card.data.json`.

Corrections applied in the fixture (not worked around in the renderer):

1. ratio `534/605` (measured card, not `37/50`)
2. stat labels MATCHES / WICKETS / ECONOMY
3. each stat group has `size.w: "full"`
4. placeholder `asset.silhouette.player`
5. footer `space.px: space.9` (~36px; measured strip inset ~37px)
