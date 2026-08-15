# news-section — the hybrid pipeline, end to end

One real section from the Southern Brave file, taken from Figma IR to a rendered
page through every stage the production pipeline uses.

```bash
node examples/news-section/pipeline.mjs
```

```
IR ──▶ compile ──▶ repair ──▶ validate ──▶ bindings ──▶ conform ──▶ render ──▶ diff
       (rules)     (model)     (@dsl)      (new)       (@conform)  (@renderer)
```

| Stage | Owner | What it decides |
| --- | --- | --- |
| **compile** | deterministic | structure, geometry, tokens. Never guesses. |
| **repair** | model (simulated) | sources, bindings, intent — what the frame cannot contain |
| **validate** | `@fanos/dsl` | is the tree legal |
| **bindings** | `binding-gate.mjs` | does every `{path}` resolve |
| **conform** | `@fanos/conform` | is it still true to the frame |
| **render + diff** | `@fanos/renderer` | does it look right |

## Result on this section

```
PASS  compile         72 nodes from 73 IR nodes (1 absorbed), token coverage 71.3%
PASS  repair          45 edits across 6 rules
PASS  validate        0 errors, 0 warnings
PASS  bindings        32 bindings, all resolve
PASS  conform         0 errors, 1 warning · 38 direct / 1 absorbed / 0 MISSING of 39
PASS  render          out/3-render.png
```

The render reproduces the design: three columns at the right widths, one lead
card, two features, three briefs, clamped headlines and summaries, dates, the
title and its call to action.

## Why the compiler leaves work behind

It refuses to guess, and a Figma frame genuinely does not contain these answers:

| Gap | Why the frame can't answer | Repair |
| --- | --- | --- |
| an image has no URL | Figma holds pixels, not sources | `image-source` → `{section.lead.image}` |
| text is one article's copy | a design shows one, a page renders many | `text-binding` |
| a crop is absolute geometry | `455×369 at −21px` is a transcription, not an intent | `image-fit` → `anchor: fill`, `fit: cover` |
| an icon carries a layer name | the renderer has its own registry | `icon-name` → `atom_icon_arrow_up_right` → `arrow_up_right` |
| a clamp is a measured height | `lines: 3` is an observation | `text-truncate` → `truncate: 3` |

Each repair in `repairs.mjs` carries the **prompt intent** it stands in for. In
production those are model calls; here they are deterministic so the run
reproduces. The harness around them is the real one — that is the part worth
testing, because it is what makes a model safe to use: every repair is auditable
(`out/repairs.json` records node, change and reason) and nothing reaches a
renderer without all three gates agreeing.

## No DSL primitive was missing

Worth stating, since it was the first thing checked. `Text.truncate`,
`Image.src/fit/alt` and `Icon.name` all already existed — the 18-node vocabulary
covered this section without extension. The compiler simply wasn't populating
`truncate`, and the renderer's icon registry already had `arrow_up_right` under a
different name.

**A gate was missing, though.** See below.

## Three defects this exercise found

**1. Nothing validated data bindings.** The repair pass first emitted
`{section.features[0].headline}`. The renderer's resolver only understands dot
paths — `features.0` reaches an array element, `features[0]` reaches nothing and
renders as literal braces on the page. Both existing gates passed it: `@fanos/dsl`
sees a legal string in a string field, and `@fanos/conform` compares geometry and
paint, which are unaffected. A model could have invented any path it liked and
the only symptom would have been braces on a shipped page.

`binding-gate.mjs` closes it. **It belongs in `@fanos/dsl`** as a validation
taking the data document, alongside T1's token checks; it lives here because
moving it is an API change to a package with 156 tests.

**2. Re-rooting a section needs its page positioning stripped.** The compiler
gives a section `place` because inside the 1366px page root it is absolutely
positioned. Re-rooted for a section-level render, that anchors it to nothing and
Playwright waits forever on an element that never becomes visible.

**3. The pixel diff cannot read this reference.** `reference.png` is a Figma
export of frame `1:4745` with a **transparent** background (`rgba(0,0,0,0)` — the
black in a screenshot is the viewer, not the design). The harness compares RGBA
against an opaque render, so every pixel differs and the score pins at 1.0
regardless of how close the render is. The `diff` step therefore reports FAIL
here and the number is meaningless — see below.

## What "pixel-perfect" honestly means here

The diff step **fails**, and two separate reasons make its score uninformative:

- **transparent reference** (defect 3) — every pixel counts as different
- **different photographs** — the reference has four distinct press images baked
  in; `data.json` uses the one URL known to resolve, repeated. A pixel diff
  across different photos is meaningless even when the layout is identical.

So the structural claim is verified — by `conform`, which checks geometry and
paint against the frame node by node and reports **0 errors, 0 MISSING of 39
painting nodes** — and the visual claim is verified by eye against
`out/3-render.png`. The pixel gate is not yet usable on this input, and calling
that a pass would be dishonest.

Making it usable needs: an alpha-aware compare (or compositing the reference onto
the render's background first), and the real per-article images.

## Files

```
news.ir.json      the extracted frame (73 nodes, IR 1.1.0)
reference.png     the designer's export of 1:4745 — 1170×444 at 2x, transparent
data.json         the content the bindings resolve against
repairs.mjs       the repair pass — 6 rules, each with its prompt intent
binding-gate.mjs  the missing gate
pipeline.mjs      the orchestrator
out/              artifacts: compiled tree, repaired tree, repair log, render
```
