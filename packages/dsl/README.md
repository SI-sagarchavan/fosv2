# @fanos/dsl

The SDUI vocabulary: every node type, every prop, every enum. The second half of
T0 — `@fanos/tokens` owns token names and values, this package owns node shapes
and consumes those tokens as types.

Five consumers derive from here and **none may be hand-maintained**: the web
renderer's prop types, the validator that gates every generated tree before
render, the JSON Schema handed to the codegen agent, Surface Admin's form
controls, and the docs.

```bash
pnpm --filter @fanos/dsl build
pnpm --filter @fanos/dsl test
```

## CLI

```bash
fos-dsl check  --tree fixtures/player-card.json \
               --theme ../tokens/fixtures/southern-brave.json \
               --surfaces ../tokens/surfaces/southern-brave.json [--json]
fos-dsl types  --out nodes.d.ts
fos-dsl schema --theme <f> --surfaces <f> --out schema.json [--subset Box,Stack,Text]
fos-dsl docs   --out vocabulary.md
```

`--surfaces` is not optional in practice: without it `surface.*` and `asset.*`
refs cannot resolve and every one of them is a T1.

## One declaration, five representations

Five things have to agree about what a prop accepts — the Zod validator, the
agent's JSON Schema, the emitted `.d.ts`, the docs table, and the token-ref
walker. Hand-writing five of anything guarantees drift, so each node's props are
declared **once** as data in `src/nodes/` and every representation is computed
from it:

```ts
{
  type: "Text",
  fields: {
    content: req(f.str()),
    style:   req(f.token("type")),   // NOT resp — see T3
    tone:    opt(f.token("color")),
    align:   opt(f.enum("start", "center", "end"), { resp: true }),
  },
}
```

Adding a prop is one line, and the type, schema, docs and validator all move
together or not at all.

## Part 1 — Wire format

Trees are emitted and stored **flat**. Recursive JSON schemas are the single
biggest cause of structured-output failures, so the agent never emits nesting —
it emits a list, and `flat.ts` is the only thing that folds it back up.

```jsonc
{
  "schemaVersion": "1.0.0",
  "nodes": [
    { "id": "card", "parent": null,  "idx": 0, "type": "Overlay", "src": "1:5000", "props": { … } },
    { "id": "cutout", "parent": "card", "idx": 0, "type": "Image", "src": "1:5001", "props": { … } }
  ]
}
```

`src` is the Figma node id and is **mandatory on every node**. It is the anchor
for the repair loop (diff region → Figma node) and for attaching `dataRef` in
phase 2 without regenerating. A node the agent inserted with no Figma origin
uses `synthetic:<parentSrc>:<n>`.

`reify` rejects rather than repairs: exactly one node with `parent === null`,
every other parent resolves, no cycles, and each parent's children carry
contiguous `idx` from 0. **A gap is an error, not something to compact** — it
means the producer dropped a node it thought it emitted, and compacting hides
that. `flatten(reify(flat))` is asserted deep-equal to the card fixture.

## Part 2 — Value wrappers

```ts
type Raw<T>  = { raw: T; _unbound: true }
type Val<T>  = TokenRef | Raw<T>
type Resp<T> = T | { base: T; md?: T; lg?: T }
```

Breakpoint keys are derived from `@fanos/tokens` (`keyof Breakpoints`), never
redeclared — if the tokens package adds a breakpoint, every `Resp<>` gains it
without an edit here. T4 checks the same keys at runtime.

**Raw is deliberate.** Under static-fidelity scope the transpiler must be able to
reproduce a frame whose values are not tokenised yet. Raw values VALIDATE but are
COUNTED; driving that count to zero is a design-ops metric, not a build blocker.
`_unbound` is required and always `true` so a raw escape can never be mistaken
for a plain object in a diff or a grep.

**Percentages are not raw debt.** `"115%"`, `"32%"` and `"full"` are relative,
survive breakpoints and re-theme correctly. They are counted separately as
`relativeValueCount`. Absolute px is what is banned, and it only ever enters via
`Raw`.

### `Resp<TypeToken>` is a type error

```ts
export type Resp<T> = [T] extends [TypeToken] ? never : T | RespObject<T>;
```

`@fanos/tokens` already resolves `type.*` per breakpoint inside the token layer —
`style: "type.dp_2_regular"` emits a different size at each viewport on its own.
Wrapping it again would create two competing responsive systems for one value.
The `[T] extends [X]` form is load-bearing: a naked conditional distributes over
unions and would break `Resp<Val<number>>`, which must keep mixed shapes like
`{ base: "space.4", md: { raw: 12, _unbound: true } }`. Both facts are asserted
as type-level tests in `tests/purity.test.ts`, checked by `pnpm typecheck`.

### `place` lives on the child

Overlay anchoring and Grid spanning are both child-positional, so they share one
namespace — one thing for the agent to learn, and the validator checks each
against the parent's type (S6, S7).

Logical `start`/`end` throughout, never `left`/`right`. ICC will need RTL and
retrofitting direction into a shipped vocabulary is miserable.

## Parts 4 & 5 — 18 node types

**Structural (8)** — Box, Stack, Grid, Section, Overlay, Carousel, Repeater,
Custom.
**Leaves (10)** — Text, RichText, Image, Icon, Button, Link, Tag, Divider,
Countdown, Tabs.

A few shapes worth the ink:

- **Repeater is a FRAGMENT, not a container.** It emits n children into its
  parent's layout and has no `surface`, `space`, `size` or `place` of its own.
  That is what lets `Stack > Repeater` and `Carousel > Repeater` both work
  without duplicating layout props. Its prop schema is built without those
  fields, so an offending tree fails the parser as well as S5.
- **Carousel controls are renderer chrome** and are never nodes in the tree.
  S10 detects them heuristically and warns rather than errors, because it is a
  guess about intent.
- **One Tag, not Badge + Chip.** LIVE/RECENT and WOMEN/MEN are the same thing
  with different tones; two node types would be an encoding coin-flip.
- **Tabs is a leaf.** It renders toggle chrome and writes state; the panels it
  switches live elsewhere in the tree.
- **Text.orientation is semantic** (`vertical-up`, not `sideways-lr`). The agent
  should not need to know CSS writing modes exist, and native does not have them.
- **Grid takes no template strings** — those are raw values in disguise.

## Part 6 — Validator

```ts
validate(tree, { registry }) // { ok, errors, warnings, metrics }
analyze(tree)                // metrics only, no validation
```

### Structural

| code | rule |
| --- | --- |
| S1 | reify failed: cycle, orphan, multi-root, idx gap |
| S2 | unknown node type |
| S3 | missing or duplicate id; missing `src` |
| S4 | Section not a direct child of root |
| S5 | Repeater carrying layout / space / size / surface props |
| S6 | `place.anchor` on a node whose parent is not an Overlay |
| S7 | `place.span` on a node whose parent is not a Grid |
| S8 | Overlay child with no `place.anchor` |
| S9 | Grid with `columns: "auto"` and no `minItemWidth` |
| S10 | Carousel with control nodes among its children — **warning**, heuristic |
| S11 | `Custom.ref` not `name@semver` |
| S12 | a prop failed its schema (shape, not resolution) — *addition* |

**Duplicate anchors between Overlay siblings are LEGAL and never flagged** —
that is how layering works. The card has two `bottom-center` children (the
cutout and the footer) and there is an explicit test for it.

### Token

| code | rule |
| --- | --- |
| T1 | a ref that does not resolve via the tokens registry |
| T2 | `Text.style` is not a TypeToken |
| T3 | a `Resp<>` wrapper around a TypeToken |
| T4 | a `Resp` breakpoint key not in the tokens package config |
| T5 | the ref resolves but is the wrong category for this prop — *addition* |

T1 messages carry the ref, the node id, the prop path and up to three near
misses. Suggestions rank by shared name segments first and character overlap
second, so `surface.card_playr` surfaces `surface.card_player` on the shared
`card` segment, and a ref with nothing in common still returns real refs from
the same category rather than nothing.

Shape errors are suppressed wherever a token rule already explained the same
value in better words — `Text.style: "color.core_neu_00"` reports T2 alone, not
T2 plus a confusing union-mismatch.

### Quality — counted, never blocking

`rawValueCount` (split: space / color / size / duration / other + total),
`rawPositionCount`, `syntheticNodeCount`, `customNodeCount`,
`tokenCoverage`, `maxDepth`, `nodeCount`.

Metrics are returned whether or not the tree validates. Withholding them would
make the number disappear exactly when someone is working on the tree.

## Part 7 — Emission

`emitTypes()` — a discriminated union on `type`, one props interface per node,
and the shared value shapes. Token unions are **imported** from `@fanos/tokens`,
never regenerated. A test compiles the output under `strict`.

`emitJsonSchema({ registry, subset? })` — the agent's structured-output contract.
Three properties, each asserted by a test:

- **No recursion.** `selfReferentialDefs()` returns empty; every `$ref` resolves
  to a `$def` that exists and nothing reaches itself through any chain.
- **Closed enums everywhere.** Token props enumerate this theme's ACTUAL refs
  (163 colours, 30 type styles, 6 surfaces), so the agent physically cannot emit
  a ref the tenant does not have. `TypeToken` carries the 30 breakpoint-complete
  styles only — `type.xl_medium` is not emittable, which is E1's whole point.
  Offsets get a `SpaceTokenNegated` enum so a badge can hang off an edge.
- **`additionalProperties: false`** on every object.

`subset` is the size budget: `["Box","Stack","Text","Image","Overlay","Divider","Icon"]`
is under 75% of the full schema and still validates the card.

`emitDocs()` — a markdown table per node type, from the same descriptors.

## Part 8 — Tree operations

`setProp`, `replaceNode`, `wrapIn`, `insertBefore`, `removeNode`, `moveNode`.

Repair **patches** the tree; it never regenerates it. Regeneration is how drift
creeps in across iterations — the model fixes the reported problem and silently
rewrites three things nobody asked about.

Every op is pure and returns a new tree, sharing untouched nodes by reference.
Each one keeps `idx` contiguous so the result still reifies:

- `removeNode` errors if the node has children unless `cascade: true`
- `moveNode` refuses to move a node into its own subtree
- `wrapIn` gives the wrapper a `synthetic:` src pointing at what it wrapped

## Part 9 — Subtree signatures and collapse

`subtreeSignature(tree, nodeId)` / `subtreeSignatures(tree)` answer one
question: **are these two DSL subtrees the same component?** Distinct from the
IR's `canonicalSignature`, which groups Figma nodes from a designer's sizing
modes and aspect buckets. This one groups the compiled tree, where the shape has
already resolved into props. Two hashes, two inputs, two jobs, and deliberately
no shared code.

`d1:` + the first 10 hex of a sha1 over `{ t: type, p: props, c: [child sigs] }`.
The prefix is versioned because signatures get stored, and a descriptor change
that reused the prefix would put two incomparable hashes in one column.

Excluded, because a CMS swaps them: `content`, `alt`, `href`, `label`, `testId`
and `_meta` at any depth; `Image.src`/`placeholder`, `Icon.name`, `Tabs.options`,
`Countdown.to`, `Custom.props` per type. `Custom.ref` is kept — the component and
its version are the shape. Raw numerics bucket to a 4px grid, so 116 and
116.0001 hash together and 116 and 182 do not.

`truncate` is IN, and it is load-bearing. On the news grid the middle cards clamp
3 lines of headline and 3 of summary while the trailing cards clamp 2 and 1.
Those are two variants of a card, not one card showing two articles, and a hash
that folded them together would propose one Repeater over all five and silently
drop a line of copy from three of them.

`proposeCollapse(tree)` groups siblings by signature and reports every run of
two or more. **It changes nothing.** Whether six card slots are one data-driven
list or six deliberate placements is a statement about the CMS behind the page,
and the tree does not contain it. It refuses to propose a scattered pair, the
root's entire child set, or a group whose members already hold a Repeater.

A proposal carries facts and no score. There is deliberately no confidence
number: on real pages every proposal lands in the same narrow band, a number
between 0 and 1 invites a threshold, and every collapse needs the same yes from
the same person whatever the number says.

`varyingContent` is the field a binder actually uses: per template-relative
node, every content prop that differs across the members. An array per node,
because an Image's `src` and `alt` routinely both vary. Empty is information —
on the news grid all three trailing cards carry the same pasted copy, so the
item's fields cannot be read off the design and have to come from a contract.

`applyCollapse(tree, proposal, binding)` is the only function here that edits.
It keeps the template, removes the other members, inserts a `Repeater` in the
template's slot and rewrites the mapped props to `{article.headline}` form.
Every surviving node keeps its `src`, and the removed members' `src` values —
every node under them, not just the roots — land on the Repeater as
`_meta.collapsedFrom`, because `src` is the anchor a pixel diff maps a region
onto and drift detection joins on.

```bash
fos-dsl collapse --tree <f>                                        # report
fos-dsl collapse --tree <f> --apply <i> --binding <f> --out <f>    # edit
```

Report-only by default. Applying takes an explicit binding file, because a
collapse with no data source is not a smaller tree — it is a tree that draws one
card where the design drew three.

`Repeater.slice: [start, end)` windows one source list. The news grid is
index-tiered — one list of six articles drawn as a lead, two features and three
briefs — and the tier is chosen by POSITION, which `when` cannot express because
nothing on article #4 marks it as a brief except being fourth. S13 rejects a
malformed slice and rejects `slice` alongside `limit`; S14 warns when two
Repeaters over one source draw overlapping windows.

**`slice` is schema-only today.** The renderer's Repeater understands `limit`
and ignores `slice`, so a tree that sets one draws the whole list. Setting it is
opt-in and nothing emits it automatically, but until the renderer lands it, a
slice is a declaration rather than a behaviour.

## Part 10 — Fixture

`fixtures/player-card.json` is the flat tree for
`organism_web_cricket_playercard`, validated against the real Southern Brave
theme. It exercises the awkward parts: an Overlay root with four anchored
children (two sharing `bottom-center`), a vertical-up Text, a negated offset
(`-space.6`), percentage sizing, and a three-stat strip with two dividers.

```
Overlay "card"          surface.card_player, clip:false, ratio 37/50
 ├ Image  "cutout"      contain, bottom-center, h 115%, scrim gradient.nue_vert_1
 ├ Text   "role"        BOWLER, type.badge_md, vertical-up, mid-start +space.4
 ├ Stack  "badges"      column, gap space.2, top-end, offset { 32%, -space.6 }
 │  ├ Box + Icon        surface.badge_captain
 │  └ Box + Icon        surface.badge_overseas
 └ Stack  "footer"      column, gap space.5, px/pb space.5, w full, bottom-center
    ├ Text  "name"      type.dp_2_regular, as h3
    └ Stack "stats"     row, between, stretch, surface.stat_strip, py space.4
       └ 3 × (Stack + 2 Text) separated by 2 Dividers
```

`rawValueCount` is **6** and not zero: `badge.size` and `icon.size` are empty in
the current token file, so the two badge Boxes need Raw width/height and their
Icons need a Raw size. That is correct and expected — it drops to zero the day
design ops populates those scales, and it is not worked around.
`rawPositionCount` is 0.

## Tests

```bash
pnpm --filter @fanos/dsl test
pnpm --filter @fanos/dsl typecheck
```

128 tests. Notable:

- the card validates with zero errors, and every acceptance mutation produces
  the RIGHT code — not merely a failure
- `flatten(reify(flat))` deep-equal to the fixture
- duplicate Overlay anchors explicitly do not error
- `wrapIn` on `name` still reifies and still validates
- the JSON Schema meta-validates against draft-2020-12, has no self-`$ref`, and
  the subset is materially smaller and still accepts the card
- the emitted `.d.ts` compiles under `strict`
- `validate.ts` and every tree op are pure — sources are grepped for `node:`,
  `process.`, `Date.now` and `Math.random`, and both run against in-memory data

## Divergences from the spec

0. **The news grid yields ONE collapse proposal, not two.** The middle column's
   two cards are the same component and do not group, because the designer set
   the thumbnail gap to 0 on one and 8 on the other. That is a real, visible
   8px; it is in the IR; and it has nothing to do with the image-crop cleanup,
   which it survives. `tests/subtree-signature.test.ts` proves the gap is the
   only difference left, by giving them the same gap and watching them merge.
   Folding them today would move one card's content 8px and call it a tidy-up —
   the fix belongs in the Figma file.

1. **`space.7` resolves in this theme.** The acceptance criteria expected
   `space.7 -> T1` on the grounds that "the scale stops at space.6", but the
   Southern Brave export runs `spacing_0`–`spacing_16` plus four half-steps.
   The T1 test uses `space.99`, and there is an explicit test asserting that
   `space.7` is accepted.

2. **The card fixture is 22 nodes, not 19.** The described structure — three
   stat groups of `Stack + 2 Text`, separated by two Dividers — is 11 nodes
   under `stats`, on top of the 11 above it. 19 is only reachable by dropping a
   stat group, so the structure was kept and the count reported honestly.

3. **Two issue codes added.** `S12` for a prop that fails its schema (shape
   rather than resolution) and `T5` for a ref that resolves but is the wrong
   category for its prop. Neither changes a specified behaviour; without them
   those failures would have to masquerade as a rule that means something else.

4. **`Action` was not specified**, so it is defined here as a closed union
   (`none | navigate | open | submit | custom`). An open record would let the
   agent invent handler names no renderer implements, failing in production
   rather than in the validator.

5. **`Image.placeholder` is an `AssetToken`, not a free string.** A free URL is
   exactly the hand-maintained value this package exists to prevent.

6. **`Val` is category-scoped.** Gaps/padding use `f.val()` → space tokens.
   `revealDelay` and `Carousel.autoplay` use `f.val("duration")` against the
   built-in `duration.*` scale in `@fanos/tokens`. A space token on a duration
   prop is T5. Raw ms still validates and is counted under `rawValueCount.duration`.
