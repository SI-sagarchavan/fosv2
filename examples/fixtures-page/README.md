# fixtures-page — the data contract

`data.json` is a sample **provider response**: the shape the fixtures surface is
bound against. It is the input the repair pass writes bindings toward, and the
input the renderer resolves them with.

The compiler never sees this file. It emits eight literal cards, because the
frame contains eight literal cards and inventing a loop is exactly the kind of
guess a deterministic compiler must refuse. Turning those eight into one
`Repeater` is the repair pass's job, and this file is what makes that job
checkable rather than a matter of taste.

## Why the flags are in the payload

Every conditional in the design has a matching boolean: `isLive`, `showResult`,
`showCountdown`, `actions.tickets.show`. That is deliberate.

`when` is declared in the DSL (`universal.ts:110`) as `f.predicate()` with
"phase 2 — schema present, contents unvalidated", and the renderer does not
evaluate it yet — `Render.tsx` handles `Repeater` but has no `when` branch. So
today a predicate is recorded and ignored.

Keeping the decision in the payload as a plain boolean means:

- the same tree renders correctly the moment `when` is evaluated, with no
  re-authoring — the predicate is `{fixture.isLive}`, not an expression;
- until then, an unresolved `{fixture.result}` renders the literal token rather
  than the string "undefined" (`resolve/data.ts` keeps unmatched paths intact),
  so a missing branch is visible instead of silently wrong;
- the provider owns the business rule. "Is this fixture live" is a server
  decision about a clock, not something a UI predicate should re-derive.

Prefer adding a flag here over writing an expression in the tree.

## Binding map

Bindings are `{dot.path}` in `Text.content`, `Image.src` and `Image.alt` only
(`resolve/data.ts`). Inside a `Repeater` the alias from `as` is in scope.

```
Stack  page
├─ Text    content="{page.title}"                    → "Fixtures & Results"
├─ Text    content="{page.filterLabel}"
└─ Stack   fixtures grid
   └─ Repeater  over="fixtures"  as="fixture"        ← the eight cards collapse here
      └─ Stack  fixture card
         ├─ Text   content="{fixture.dayLabel}"      → "SATURDAY, 18 JULY"
         ├─ Text   content="{fixture.statusLabel}"   when={fixture.isCompleted}
         ├─ Stack  live badge                        when={fixture.isLive}
         ├─ Text   content="{fixture.competition} • {fixture.startTime}"
         ├─ Stack  score row
         │  ├─ Text  content="{fixture.home.code}"
         │  ├─ Image src="{fixture.home.logo}"  alt="{fixture.home.name}"
         │  ├─ Text  content="{fixture.home.scoreLabel}"
         │  ├─ Text  content="{fixture.away.scoreLabel}"
         │  ├─ Image src="{fixture.away.logo}"  alt="{fixture.away.name}"
         │  └─ Text  content="{fixture.away.code}"
         ├─ Stack  countdown            when={fixture.showCountdown}
         │  └─ Text content="{fixture.countdown.days}"  (+ hours / mins / secs)
         ├─ Text   content="{fixture.result}"        when={fixture.showResult}
         ├─ Text   content="{fixture.venue}"         when={fixture.showVenue}
         ├─ Stack  tickets CTA                       when={fixture.actions.tickets.show}
         │  └─ Text content="{fixture.actions.tickets.label}"
         └─ Stack  match centre CTA
            └─ Text content="{fixture.actions.matchCentre.label}"
```

Two shapes worth noting:

- **`scoreLabel` is separate from `score`.** The live fixture shows "Yet to Bat"
  where a completed one shows "172/3". Same slot, same binding, different value
  — so the tree needs one Text, not two behind predicates. `score` stays as the
  machine-readable number for anything that needs to compare.
- **Logos are `asset.*` refs, not URLs.** They resolve through the surface set's
  `assets` map (`raw-schema.ts` `SurfaceSet.assets`), which is the same
  indirection the compiler already uses for textures. A CDN URL in the payload
  would bypass the theme and break tenanting.

## Repeater rules that bite

`Repeater` is a **fragment** (`structural.ts:110`). It emits its children into
the parent's layout and carries no `surface`, `space`, `size` or `place` —
`REPEATER_FORBIDDEN_PROPS` enforces this. So the grid's gap and columns belong
on the parent `Stack`, and the card's own plate belongs on the card inside the
Repeater. Getting that backwards gives every card a wrapper box and breaks the
grid.

`limit` caps the list; `paginate` is schema-only for now.

## What is NOT here

No countdown ticking, no filter behaviour, no pagination. The countdown is a
static `{days, hours, mins, secs}` because the tree renders a value, not a
timer — a live countdown is a client behaviour that belongs to a `Custom` node
(`structural.ts:130`), not to SDUI text.
