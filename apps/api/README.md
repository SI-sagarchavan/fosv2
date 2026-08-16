# @fanos/api

The FanOS control plane. Stores the pipeline's artifacts, versions surfaces,
executes pipeline runs, and holds the fidelity gate that decides what may ship.

## Shape: hexagonal (ports and adapters)

The domain sits in the middle and depends on nothing. Everything that touches
the outside world — Postgres, Redis, the filesystem, HTTP, and the FanOS
compiler itself — is an adapter behind an interface the domain owns.

```
                 driving adapters              driven adapters
              ┌────────────────────┐        ┌──────────────────────┐
   HTTP  ───► │  http/server.ts    │        │ drizzle-*-repo.ts    │ ──► Postgres
              │  modules/*/adapters│  ────► │ fs-blob-store.ts     │ ──► disk
  queue  ───► │  worker.ts         │        │ bullmq-queue.ts      │ ──► Redis
              └────────────────────┘        │ fanos-toolchain.ts   │ ──► @fanos/compile
                        │                   └──────────────────────┘     @fanos/conform
                        ▼                              ▲
                 ┌─────────────────────────────────────┴──┐
                 │  app/      use cases, ports only        │
                 │  domain/   types, rules, port interfaces│
                 │  kernel/   AppError, hashing, clock     │
                 └────────────────────────────────────────┘
```

Each module is a slice of that hexagon:

```
modules/surfaces/
  domain/surface.ts    types + pure rules (canPublish, nextVersionNumber, publishTransition)
  domain/ports.ts      interface SurfaceRepository, ArtifactLookup, GateLookup
  app/surface-service.ts   orchestration — resolves refs, asks the domain, applies the answer
  adapters/drizzle-surface-repo.ts   implements SurfaceRepository
  adapters/routes.ts                 the HTTP driving adapter
```

**Consumers declare the ports they need.** `surfaces` defines `ArtifactLookup`
(three methods) rather than importing the artifacts module; `ArtifactService`
happens to satisfy it structurally. Neither module imports the other's
internals, and a test fakes three methods instead of a service.

### What this bought

Concretely: `SurfaceService.publish` and the run state machine went from
**untested** — they needed a live Postgres, so they were verified by hand with
curl — to covered by fast tests. `canPublish` refusing to publish a treeless
version even with an override, a cancel landing mid-run, a permanent failure
not burning three retries: one test each, no infrastructure.

The `Toolchain` port matters most. `@fanos/compile` and `@fanos/conform` used to
be imported straight into the pipeline, so exercising a compile failure meant
producing a deliberately broken Figma export. Behind an interface it is
`brokenToolchain("permanent")`.

### What it did not buy

The domain's `nextVersionNumber` is correct given a complete list, but it cannot
make two concurrent callers agree — that is a row lock, and a row lock is a
database guarantee. The in-memory fake will cheerfully pass a test that real
concurrency would fail. So the version allocation, the partial-index
idempotency, and the publish transaction are covered by
`tests/integration/` against real Postgres. Ports make rules testable; they do
not make storage guarantees portable.

### Keeping it

`tests/architecture.test.ts` fails the build if a `kernel/`, `domain/` or `app/`
file imports `drizzle-orm`, `fastify`, `bullmq`, `ioredis`, `postgres` or
`@fanos/*`; if one names a `*Row` persistence type; if one calls `new Date()`
instead of the `Clock` port; or if anything but the three composition files
(`context.ts`, `index.ts`, `worker.ts`) reaches for a concrete adapter.

Ports-and-adapters decays silently — someone needs one field, imports the row
type "just here", and six months later the domain is welded to the ORM again.
Code review does not reliably catch that. This does.

## Why this is not CQRS

The question came up, so it is worth writing down.

CQRS pays for itself under three conditions: reads and writes scale on different
axes, the change history *is* the product, or separate teams need to own the two
sides. None of them hold here. Writes are pipeline runs triggered by humans and
CI; reads are a dashboard and a published-tree lookup. The audit requirement is
"who changed what", not "rebuild the world from an event log".

What CQRS would actually buy us is an eventually-consistent read path, and then
every feature after it would have to answer "what does the user see immediately
after they click publish". That is a permanent tax against a scaling problem we
do not have.

The domain has a better-fitting shape anyway. **Artifacts are immutable and
content-addressed**, so provenance, replay and time-travel — the things people
reach for event sourcing to get — fall out of ordinary versioned rows. A surface
version is frozen the moment it exists; publishing moves a pointer. That is why
`audit_log` is eight columns rather than an event store.

Two habits *are* borrowed from CQRS, because they cost nothing:

- **Write DTOs are separate types from read DTOs** (`UploadArtifactCommand` vs
  `ArtifactView`). This is the seam to cut along if one module ever does need a
  real read model.
- **Commands are verb-shaped**, not CRUD-on-tables: `publish`, `cancel`,
  `createVersion`. The domain is genuinely verb-shaped.

If the live fan-facing runtime ever lands and needs sub-50ms reads at match-day
fan-out, the thing to add is a projection for *that* module only — not an
architecture for all of them.

## Layout

```
src/
  index.ts                 HTTP process        ┐
  worker.ts                queue worker        ├ composition: the only files
  context.ts               composition root    ┘ allowed to pick adapters
  config.ts                env, parsed once, or the process refuses to boot

  kernel/                  shared domain primitives, zero infrastructure
    errors.ts              AppError + isPermanent — the retry policy, in one place
    hash.ts                sha256 + canonical JSON — artifact identity
    clock.ts               time as a port
    audit.ts               the audit port

  modules/<name>/
    domain/                types, pure rules, port interfaces
    app/                   use cases, depending on ports only
    adapters/              Drizzle / BullMQ / fs / Fastify implementations

  platform/                infrastructure with no domain of its own
    db/schema.ts           the whole relational model, one file
    db/client.ts           pool; handed to adapters, never to services
    db/migrate.ts          standalone migrator
    http/server.ts         Fastify: auth, error mapping, route registration
    clock.ts               systemClock — the only `new Date()` in the app
```

The modules: `projects` (tenants, and slug → id for everyone else), `artifacts`
(the store of record — immutable, deduplicated), `surfaces` (versions, publish,
rollback), `runs` (plan, state machine, step trace), `fidelity` (the gate),
`audit` (append-only who-did-what).

**No module touches another module's tables** — only the ports it declares.
That rule is why a module could be extracted later without an audit.

### The two ideas the schema is built on

**Artifacts are content-addressed.** An IR extract, a compiled DSL tree, a render
PNG and a conformance report are all rows in one table keyed by the sha256 of
their bytes, unique per project. Re-uploading identical bytes is a no-op, which
makes the whole pipeline idempotent for free — and makes "what exactly did we
ship in March" answerable forever.

JSON is hashed in canonical form (sorted keys), so two callers who serialise the
same tree differently still land on one artifact.

**Runs are a state machine with a step trace.** Every execution is a `run` with
ordered `run_steps`, each pointing at the artifact it produced. That trace is
the debuggable history. Steps are not individually retried — a failed step fails
the run and BullMQ retries the whole thing — because the steps are cheap and
deterministic, and partial resume would introduce the half-applied state this
design exists to avoid.

`AppError`s with a 4xx status are treated as fatal and not retried: a bad input
artifact will fail identically on every attempt.

### Invariants worth not breaking

- Version numbers are dense and monotonic per surface, allocated inside a
  transaction with the surface row locked. Two concurrent compiles cannot both
  claim v4.
- Exactly one version per surface is `published`; publishing archives the
  previous one. Rollback is a pointer move, never a restore.
- Publishing a version that failed its fidelity gate requires
  `overrideFidelityGate: true`, and the override lands in the audit log with a
  reason.
- Thresholds are copied onto every fidelity report. Tightening the gate next
  quarter must not retroactively turn a shipped pass into a fail.
- Blob first, row second — always. A blob with no row is garbage we can sweep;
  a row with no blob is a broken artifact.

## Running it

```bash
docker compose up -d          # postgres + redis + electric
cp .env.example .env
pnpm build
pnpm db:migrate
pnpm start                    # HTTP on :4000
pnpm start:worker             # in a second terminal
```

`pnpm test` and `pnpm typecheck` need neither container — the unit suite runs
entirely over in-memory adapters. `pnpm test:integration` needs Postgres and
covers what fakes cannot: row locks, partial-index conflicts, transactions.

## API

All routes are under `/v1` and take a project slug or uuid as `:project`.
Auth is a bearer token or `x-api-key` against `API_KEYS`; with no keys set,
auth is off (development only — the config refuses to boot production that way).

| Method | Route | What it does |
| --- | --- | --- |
| `POST` | `/projects` | create a tenant |
| `GET` | `/projects/:project/audit` | who did what |
| `POST` | `/projects/:project/artifacts` | upload; returns 200 if the bytes already existed, 201 if new |
| `GET` | `/projects/:project/artifacts/:ref` | metadata, by uuid or digest |
| `GET` | `/projects/:project/artifacts/:ref/content` | the bytes; immutable, cached forever |
| `POST` | `/projects/:project/surfaces` | create a surface |
| `POST` | `/projects/:project/surfaces/:key/versions` | hand-author a version |
| `GET` | `/projects/:project/surfaces/:key/versions` | version history |
| `POST` | `/projects/:project/surfaces/:key/publish` | move the published pointer |
| `GET` | `/projects/:project/surfaces/:key/live` | **the client read path** — published SDUI tree |
| `POST` | `/projects/:project/runs` | start a pipeline run; 202 + run id |
| `GET` | `/projects/:project/runs/:run` | run status with its full step trace |
| `POST` | `/projects/:project/runs/:run/cancel` | cancel a queued or running run |

### A run, end to end

```bash
# 1. upload the two inputs (both idempotent — re-running this is free)
curl -sX POST localhost:4000/v1/projects/acme/artifacts \
  -H 'content-type: application/json' \
  -d '{"kind":"figma_ir","json":'"$(cat player-card.ir.json)"'}'

curl -sX POST localhost:4000/v1/projects/acme/artifacts \
  -H 'content-type: application/json' \
  -d '{"kind":"token_set","json":'"$(cat theme.json)"'}'

# 2. start the run — returns 202 immediately
curl -sX POST localhost:4000/v1/projects/acme/runs \
  -H 'content-type: application/json' \
  -d '{"kind":"pipeline","input":{
        "surfaceKey":"player-card",
        "irArtifact":"<ir digest>",
        "themeArtifact":"<theme digest>"
      },"idempotencyKey":"player-card-2026-08-15"}'

# 3. poll. steps[] carries compile stats, conform findings, timings
curl -s localhost:4000/v1/projects/acme/runs/<id>

# 4. publish, if the gate passed
curl -sX POST localhost:4000/v1/projects/acme/surfaces/player-card/publish \
  -H 'content-type: application/json' -d '{"version":1}'
```

The `pipeline` plan is `load-inputs → compile → version → conform`. A failing
fidelity gate does **not** fail the run — the run succeeded at producing a
verdict. The verdict is what blocks publishing.

`render` and `diff` runs are planned but not implemented: they need the
Playwright harness in `@fanos/renderer` running out-of-process. `planFor` throws
for them rather than silently succeeding.

## Live progress, and why closing the tab is safe

`GET /projects/:project/sync` streams `runs` and `run_steps` to the browser
through ElectricSQL, so a client watching a run sees each step transition as it
lands.

The property people usually have to build for — "close the tab, come back, the
work is still going and the progress is intact" — is not built here. It falls
out of a decision made earlier: **the queue carries only a run id, and Postgres
owns run state.** The worker never knew a client was watching, and every
transition was already durable. All Electric adds is a read path that can
resume.

So the client holds no progress state and never asks what it missed. A fresh
mount subscribes at `offset=-1`, gets the current state immediately, then goes
live. A reconnect with a saved `handle` + `offset` gets only the deltas.

**Electric is never exposed to a browser.** It serves whatever `where` clause it
is handed and knows nothing about API keys or tenants, which makes that clause a
security boundary. Clients therefore never supply one: they name a subject
(`?run=<id>`), the service checks the run belongs to the project, and
`shapeForRun` derives the scoping from ids the server already resolved. A run id
guessed from another tenant 404s without Electric being called at all.

Two things that fail silently if disturbed, both commented at the site:

- `wal_level=logical` in docker-compose. The default `replica` carries no row
  images, so shapes come up empty with no error anywhere.
- `Access-Control-Expose-Headers` on the API. Without it the browser hides the
  `electric-*` headers from JS, the client loses its cursor, and every reconnect
  quietly degrades into a full refetch.

`apps/web/app/runs/[project]/[run]` is the reference consumer.

## Where this goes next

In rough order of when it will start to hurt:

1. **Blob store to S3.** `BlobStore` is two methods for exactly this reason.
2. **`render` / `diff` steps**, driving `@fanos/renderer`'s Playwright harness in
   a sidecar. This is the biggest functional gap.
3. **Artifact GC.** Nothing sweeps blobs whose rows were cascade-deleted yet.
4. **Per-project fidelity thresholds.** `FidelityService` takes them in its
   constructor today; they want to live on the project row.
5. **Read model for `/live`** — and only then, and only for that route.
