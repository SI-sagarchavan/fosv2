# Surface Studio

The page board. Listens on `http://localhost:3000` for sends from
**FanOS Surface Canvas**, and lets you look inside what the pipeline made of them.
The ZIP in the plugin is the escape hatch for when this is down.

```bash
pnpm --filter @fanos/surface-studio dev
pnpm --filter @fanos/surface-studio test
```

Studio stores nothing. The board reads Postgres through the control plane's Electric proxy.

## Pages

| Route | What it is |
| --- | --- |
| `#/` | **Board.** Every export, with search, status filter (awaiting / compiled / dismissed), file filter, sort, grid or list, and dismiss / restore. |
| `#/export/:id` | One export. **Overview** (plates, compile trace, run preview), **Render**, **IR**, **DSL**, **Gaps**, **Data & logic**. |
| `#/playground` | The same views over any IR file you drop in. Needs only Studio — no control plane, no Postgres. |
| `#/pipeline` | How a frame becomes a page, what each stage loses, and what exists for connecting data and logic. |

`?node=<id>` on the IR and DSL tabs selects a row, so a gap links straight to the layer it is about.

- **IR** — the Figma layers, each marked *direct* (a DSL node draws it), *absorbed* (a node covers it), *missing* (it paints and nothing draws it) or *scaffold* (no ink).
- **DSL** — the compiled tree; every node links back to its Figma `src`, with validator and gate findings against it.
- **Gaps** — what the trip lost, guessed or cannot say: content, coverage, vocabulary, tokens, judgment calls, validity, logic.
- **Data & logic** — paste or fetch a sample API response; Studio proposes which text, images and repeating cards bind to which fields, lists the response fields nothing reads, and renders the result. The plan it builds is the existing `binding_plan` format.

## Routes

| Route | Who |
| --- | --- |
| `GET /v1/health` | plugin ping |
| `POST /v1/exports` | plugin send (IR + PNGs) |
| `POST /v1/exports/:id/status` | dismiss / restore a board row |
| `GET /v1/sync` | the board, via the control plane's Electric proxy |
| `POST /v1/compile` | start a pipeline run from an export |
| `POST /v1/preview` | plugin: compile + render an IR, nothing stored |
| `GET /v1/preview/:ref` | a run or `dsl_tree` artifact, rendered as a page |
| `POST /v1/inspect` | IR → DSL, the per-node join, the gap report. `ir` by value or `irArtifact` by id |
| `POST /v1/bindings` | refs, suggestions and a render against a sample payload and plan |
| `GET /v1/datasets[/:name]` | named sample datasets served by the control plane |
| `GET /v1/blobs/:id` | artifact bytes (plates, IR) |

`/v1/inspect` and `/v1/bindings` use the real compiler, the real fidelity gate and the real validator, so what
they show cannot flatter the pipeline. With no `token_set` in the control plane the theme falls back to
`packages/tokens/fixtures`, and the response says so in `themeSource`.
