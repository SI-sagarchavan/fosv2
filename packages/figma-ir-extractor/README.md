# @fanos/figma-ir-extractor

A Figma plugin that walks a selected page frame, normalizes every node into
**Frame IR**, exports PNGs of the top-level section candidates, and downloads
both to disk.

This is an extraction pipe and nothing else. It does not lint, score, segment,
cluster, annotate, call any backend, or persist anything between runs.

## Why a plugin and not the REST API

We have no admin seat on the Figma org, so the REST API is unavailable.
Extraction therefore runs inside a development-mode plugin, which also gets us
`layoutSizing*`, resolved variable names and `exportAsync` for free.

## Build

```bash
pnpm install          # from the monorepo root
pnpm --filter @fanos/figma-ir-extractor build
```

Outputs `dist/code.js` (sandbox) and `dist/ui.html` (iframe, JS inlined —
Figma only accepts a single self-contained UI file).

`pnpm --filter @fanos/figma-ir-extractor watch` rebuilds on save.

## Install in Figma desktop

1. Build first — the manifest points at `dist/`, which is gitignored.
2. Figma desktop → **Plugins → Development → Import plugin from manifest…**
3. Pick `packages/figma-ir-extractor/manifest.json`.
4. It now appears under **Plugins → Development → FanOS IR Extractor**.

After a rebuild, re-run the plugin — no re-import needed.

## Run

1. Select **exactly one** frame (the page frame you want a corpus row for).
   Zero or multiple selections are rejected with an error.
2. Run the plugin, click **Export IR**.
3. The summary panel appears with the files ready to save:
   - **Save all N files** writes a single `<fileName>__<pageName>__<rootNodeId>.ir.zip`
     containing everything — one save panel, and the only sane option once
     there are dozens of PNGs.
   - **Individual files** expands to a link per file if you want them loose:
     `<fileName>__<pageName>__<rootNodeId>.ir.json` plus one `<nodeId>.png` per
     section candidate.

The root node id is in the filename because `fileName` and `pageName` are not
distinguishing in practice — a local dev plugin gets no `fileKey`, and an
unpublished file reports `Untitled` / `Page 1`. Without it, two exports from
different frames of the same file collide and one silently overwrites the
other. `1:4366` becomes `1-4366`, matching the PNGs and Figma's own
`?node-id=` URL form.

The summary panel reports node count, screenshot count, unbound %, hidden nodes
skipped, extraction errors, schema validity and wall-clock duration.

### Why saving is click-driven

Figma **desktop** answers every download with a native modal save panel, and
any download queued while that panel is open is silently dropped. An automatic
burst of downloads therefore loses everything after the first file — the run
succeeds, the summary says "5 screenshots", and four PNGs never reach disk.
So nothing downloads on its own: one user gesture, one saved file. The ZIP
button exists so that gesture only has to happen once.

The ZIP is written by `src/zip.ts` — store-only, ~120 lines, no dependency, and
verified against Info-ZIP.

### PNG file names

Named `<nodeId>.png` with `:` replaced by `-`, e.g. node `13744:75493` becomes
`13744-75493.png`. Colons are a menace in macOS save panels and Finder, and `-`
is exactly how Figma encodes node ids in its own URLs (`?node-id=13744-75493`),
so the mapping back to `id` in the IR stays mechanical.

## Output format

One JSON document per page:

```jsonc
{
  "fileKey": "abc123",        // null when the plugin cannot read it
  "fileName": "FanOS Web",
  "pageName": "Match Centre",
  "rootNodeId": "12:345",
  "extractedAt": "2026-08-06T09:12:33.101Z",
  "irVersion": "1.1.0",
  "breakpointHint": 1440,     // root frame width
  "root": { /* FrameIRNode */ }
}
```

Every node is the same shape (`src/ir/schema.ts` is the source of truth):

```jsonc
{
  "id": "12:346",
  "name": "Match Card",
  "type": "INSTANCE",              // FRAME|GROUP|TEXT|IMAGE|VECTOR|INSTANCE|COMPONENT|OTHER
  "componentKey": "a1b2c3…",       // INSTANCE / COMPONENT only

  "layout": {
    "mode": "vertical",            // vertical|horizontal|none
    "gap": { "value": 12, "tokenRef": "space/md", "unbound": false },
    "padding": { "top": {…}, "right": {…}, "bottom": {…}, "left": {…} },
    "align": "CENTER",             // counterAxisAlignItems
    "justify": "SPACE_BETWEEN",    // primaryAxisAlignItems
    "wrap": false,
    "sizing": { "w": "fill", "h": "hug" },
    "positioning": "auto"          // auto|absolute
  },

  "geometry": {
    "bbox":    { "x": 0, "y": 0, "w": 320, "h": 448 },   // absolute
    "relBbox": { "x": 0, "y": 0, "w": 320, "h": 448 },   // relative to parent
    "aspect": 0.7143,
    "aspectBucket": "portrait"     // square|portrait|landscape|wide|ultrawide
  },

  "fill":   { "tokenRef": "color/brand/blue/700", "unbound": false },
  "stroke": { "raw": "#e0e0e0", "weight": 1, "unbound": true },
  "radius": { "value": 8, "tokenRef": "radius/md", "unbound": false },
  "effects": [{ "type": "DROP_SHADOW", "styleRef": "elevation/1", "unbound": false }],
  "opacity": 1,
  "clipsContent": true,

  "text": {
    "characters": "Mumbai Indians",
    "styleRef": "text/body/strong",
    "unbound": false,
    "fontSize": 14,
    "fontFamily": "Inter",
    "fontWeight": 600,
    "lineHeight": 20,              // px, or "auto"
    "autoResize": "HEIGHT",
    "lines": 1                     // estimate: height / lineHeight
  },
  "image": { "fit": "FILL", "hasImageFill": true },

  "structuralSignature": "s1:9f2c…",
  "repeatedSiblings": 5,
  "depth": 3,
  "childCount": 2,
  "children": []
}
```

### aspectBucket thresholds

| bucket     | aspect (w/h)     |
| ---------- | ---------------- |
| portrait   | `< 0.95`         |
| square     | `0.95 – 1.05`    |
| landscape  | `> 1.05 – < 1.9` |
| wide       | `1.9 – < 3`      |
| ultrawide  | `>= 3`           |

## Derived fields

`structuralSignature`, `canonicalSignature`, `repeatedSiblings`, `depth` and
`childCount` are computed during/after traversal and never read from Figma.
Hidden nodes never
reach them — they are dropped during traversal.

Grouping happens at three levels, and they answer different questions:

| | question | field |
| --- | --- | --- |
| identity | is this literally the same component? | `componentKey` |
| family | is this the same kind of thing? | `canonicalSignature` |
| exact shape | is this the identical structure? | `structuralSignature` |

No single one does every job. On a real page, five instances of one player card
share a `componentKey` but split into 4 strict signatures (an optional captain
badge), while three fixture cards have 3 different `componentKey`s but only 2
distinct shapes. Use the level that matches the question.

**structuralSignature** — a hash of SHAPE only:

```
${type}:${layout.mode}:${sizing.w}${sizing.h}:${childCount}:${aspectBucket}
```

plus the recursive signatures of children, folded three levels deep. It
deliberately excludes text characters, colours, ids, names and exact
dimensions, so two visually different instances of the same card component
hash identically. Format is `s2:<16 hex>`; the prefix versions the descriptor
so an old corpus is detectable after a format change.

**`aspectBucket` is suppressed for content-sized nodes.** When either axis is
`hug`, the node's aspect ratio is a measurement of what is inside it, and
`aspectBucket` is replaced by the literal `hug`. Found on a real page: the
hug-sized stat text `116.67` bucketed `ultrawide` while `300` bucketed
`landscape`, which split five instances of one player-card component into five
signature groups. Fixed-size nodes keep their real bucket.

What this does **not** collapse is a genuine variant. A card carrying an
optional captain badge has a different `childCount` from one without, so it
gets a different signature — correctly, since the shape a generator must emit
really is different. Component *identity* across variants is `componentKey`,
not the signature; use both.

**canonicalSignature** — the strict descriptor minus `childCount`, folded
**one** level instead of three. Format `c1:<16 hex>`.

Dropping the count is what lets one component's instances collapse: the badge
row inside a player card holds 0, 1 or 2 badges across five instances of the
same component — identical in kind, different in count. The shallower depth
stops the badge subtree itself from entering the hash.

Depth 1 rather than 3 was chosen by grid-searching 45 schemes (5 descriptors ×
3 depths × ordered/sorted/deduped children) against a discriminating pair drawn
from a real page: **five player cards must collapse to one group, and three
fixture cards must stay two.** No descriptor satisfies both at depth 3. Both
are locked in as tests.

Order is preserved, so a button with a leading icon stays distinct from one
with a trailing icon.

One subtlety worth knowing when diffing corpus rows: the strict signature folds
three levels, but the descriptor sitting at depth 3 carries a `childCount`, so
adding or removing a node at depth **4** still moves it. The canonical
signature carries no count and folds one level, so it does not. Both behaviours
are locked in by tests.

What it does **not** collapse is a variant that differs at the first level — a
nav row of five items where one carries a dropdown chevron stays `4,4,4,4,1`.
That is deliberate: the shape a generator must emit really is different. Reach
for `componentKey` when you want identity regardless of variant.

**repeatedSiblings** — the length of the *consecutive* run of siblings sharing a
**canonical** signature, written onto every member of the run. Canonical, not
strict, because a row of one component's instances is a repeated run even when
an optional badge makes their exact shapes differ — on a real page the strict
signature reported `1,1,1,1,1` for a row of five cards. Five match cards in a
row all report 5; `card, card, banner, card` reports `2, 2, 1, 1`. Nodes with
no matching neighbour report 1.

Both live in `src/ir/signature.ts` — pure functions, zero imports, no Figma
dependency, unit tested against plain IR fixtures.

## Token resolution

For fills, strokes, `itemSpacing`, the four paddings, `cornerRadius` and text
properties, in order:

1. `node.boundVariables` (and per-paint `boundVariables.color`) →
   `figma.variables.getVariableByIdAsync()` → `tokenRef`, the variable's full
   name with `/` preserved, e.g. `color/brand/blue/700`.
2. `fillStyleId` / `strokeStyleId` / `effectStyleId` / `textStyleId` →
   `figma.getStyleByIdAsync()` → `styleId` + `styleRef` (the style name).
   Treated as bound.
3. Neither → record `raw` and set `unbound: true`. `raw` is lossless enough to
   reproduce the value:

   | paint | `raw` |
   | --- | --- |
   | solid | `#0b1e3f`, or `#0b1e3f80` with alpha |
   | image | `IMAGE:FILL` (the `scaleMode`) |
   | gradient | `GRADIENT_LINEAR(#ffffff 0%, #00000080 100%; m=[a,b,tx,c,d,ty])` |
   | mixed per-range | `MIXED` |

   Gradient stops are listed in order with their positions, and `m=` is Figma's
   `gradientTransform` carried verbatim so angle and extent stay recoverable —
   deriving an angle would mean guessing at a convention, while the matrix
   cannot be wrong. This matters: on a real page, gradients were the single
   largest category of unbound fill (243 of 1058), and recording only
   `"GRADIENT_LINEAR"` would have dropped every colour in them.

Nothing is ever silently dropped: every value is a `tokenRef`, a `styleRef`, or
flagged `unbound`. `unbound` is skipped for zero/absent values — a `0` gap is
not a hardcoded magic number.

Resolved variables and styles are memoized in `Map`s for the whole run; real
files re-reference the same handful of tokens hundreds of times.

## Behaviour notes

- Traversal uses an explicit stack, never recursion — some client files nest
  hundreds of levels deep.
- The walk yields to the event loop every 500 nodes so Figma stays responsive
  and the progress line updates.
- Per-node normalization is wrapped in `try/catch`. A failure emits a node with
  `type: "OTHER"` and an `extractionError` string instead of aborting the run.
- Nodes with `visible === false` are dropped along with their subtree; the
  count lands in the summary as **Skipped (hidden)**.

  Worth knowing before that number is dismissed: on a measured real page,
  hidden nodes outnumbered visible ones roughly **3:1** (1229 of 1596 sat
  inside hidden subtrees). Whatever those are — responsive variants, component
  states, abandoned work — the corpus does not currently contain them. If they
  turn out to matter, collecting them is a change to `traverse()` plus an
  `irVersion` bump, but it also means re-exporting every row already gathered.
- The JSON is written compact. At depth 18 a 2-space indent tripled the file
  for no benefit; `jq .` restores it when a human needs to read one.
- Screenshots: every direct child of the root, `PNG @2x`, named `<nodeId>.png`
  with colons swapped for dashes. Children with zero area or width under 40px
  are skipped; the export is capped at 40 nodes and logs plus notifies when it
  truncates.
- `networkAccess.allowedDomains` is `["none"]`. The plugin makes no network
  calls of any kind.
- `documentAccess` is `dynamic-page`, so only async APIs are used —
  `getVariableByIdAsync`, `getStyleByIdAsync`, `getMainComponentAsync`.

## Tests

```bash
pnpm --filter @fanos/figma-ir-extractor test
pnpm --filter @fanos/figma-ir-extractor typecheck
```

`tests/zip.test.ts` checks the archive writer against the Info-ZIP reference
CRC values and the three required section signatures.

`tests/signature.test.ts` runs in plain Node with no Figma stub, and covers the
acceptance criteria: identical signatures across differently-populated instances
of one component, `repeatedSiblings === 5` for a row of five match cards,
consecutive-run semantics, depth-limit behaviour, and stack safety on a
20,000-level tree.

## Performance

A ~2000-node page extracts in a few seconds on Figma desktop. The costs that
matter are variable/style lookups (memoized), the once-per-node async
normalization, and PNG export (bounded at 40).
