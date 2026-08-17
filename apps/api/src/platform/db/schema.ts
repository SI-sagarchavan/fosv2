/**
 * The whole relational model, in one file so the shape is readable at a glance.
 *
 * Two ideas carry most of the weight:
 *
 *   1. Artifacts are immutable and content-addressed. An IR extract, a compiled
 *      DSL tree, a render PNG and a conformance report are all rows in one
 *      table keyed by the sha256 of their bytes. Re-uploading identical bytes
 *      is a no-op, so the pipeline is idempotent for free and "what exactly did
 *      we ship" is answerable forever without an event log.
 *
 *   2. Runs are a state machine with a step trace. Everything the pipeline does
 *      is a `run` with ordered `run_steps`, each step pointing at the artifact
 *      it produced. That trace is the debuggable history, and it is why we do
 *      not need event sourcing to answer "why did this surface come out wrong".
 *
 * Surfaces are the only genuinely mutable thing here, and even they mutate only
 * by gaining a new immutable version or moving a published pointer.
 */
import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** Every kind of blob the pipeline produces. Additive only — old rows keep their kind forever. */
export const artifactKind = pgEnum("artifact_kind", [
  "figma_ir",
  "token_set",
  "dsl_tree",
  "surface_set",
  "render_png",
  "conform_report",
  "diff_report",
  "screenshot",
]);

export const runKind = pgEnum("run_kind", ["compile", "conform", "render", "diff", "pipeline"]);

export const runStatus = pgEnum("run_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const stepStatus = pgEnum("step_status", [
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
]);

/** draft -> candidate happens when a run finishes; candidate -> published is a human act. */
export const versionStatus = pgEnum("version_status", [
  "draft",
  "candidate",
  "published",
  "archived",
]);

// ---------------------------------------------------------------------------
// projects — the tenant boundary. Every other row hangs off one.
// ---------------------------------------------------------------------------

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    /** Figma theme UUID this project's tokens were exported from, when known. */
    themeUuid: text("theme_uuid"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("projects_slug_key").on(t.slug)],
);

// ---------------------------------------------------------------------------
// artifacts — content-addressed, immutable. The store of record.
// ---------------------------------------------------------------------------

export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: artifactKind("kind").notNull(),
    /** Lowercase hex sha256 of the bytes. The real identity of the row. */
    digest: text("digest").notNull(),
    mediaType: text("media_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    /** Opaque to the DB; the blob driver knows how to turn it back into bytes. */
    storageKey: text("storage_key").notNull(),
    /** Small, queryable facts about the blob — node counts, coverage, dimensions. */
    meta: jsonb("meta").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by"),
  },
  (t) => [
    // Same bytes uploaded twice into one project is one row. This is what makes
    // the whole pipeline safely retryable.
    uniqueIndex("artifacts_project_digest_key").on(t.projectId, t.digest),
    index("artifacts_project_kind_idx").on(t.projectId, t.kind, t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// figma exports — the front door. A designer pressing "Send" is an event.
//
// The IR and the section screenshots are NOT stored here: they are artifacts,
// content-addressed like everything else. What this records is the act — which
// frame, from which file and page, at what health, by whom.
//
// That split is the whole point. Re-exporting an unchanged frame costs one
// small row rather than another copy of a 130KB IR document, because the bytes
// hash to an artifact that already exists. Exports are an append-only log;
// artifacts are deduplicated content. Neither has to compromise for the other.
// ---------------------------------------------------------------------------

/**
 * `received` is what the plugin creates. Promotion is what turns a frame into
 * pipeline work, and is deliberately a separate act — see the note on
 * `promotedRunId`.
 */
export const exportStatus = pgEnum("export_status", ["received", "promoted", "dismissed"]);

/**
 * Which Figma files belong to which tenant.
 *
 * The plugin has no idea projects exist — it knows a file key. Something has to
 * turn one into the other, and putting it here means the ingest route resolves
 * a tenant without the plugin, the designer, or Surface Studio being taught
 * about tenancy.
 */
export const projectFigmaFiles = pgTable(
  "project_figma_files",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    fileKey: text("file_key").notNull(),
    fileName: text("file_name"),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // A Figma file belongs to exactly one project. Two tenants claiming the
    // same file is an ambiguity the ingest route could not resolve.
    uniqueIndex("project_figma_files_file_key_key").on(t.fileKey),
    index("project_figma_files_project_idx").on(t.projectId),
  ],
);

export const figmaExports = pgTable(
  "figma_exports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),

    // --- where it came from -------------------------------------------------
    /** Null for an unsaved/local Figma file, which the plugin allows. */
    fileKey: text("file_key"),
    fileName: text("file_name").notNull(),
    pageName: text("page_name").notNull(),
    rootNodeId: text("root_node_id"),
    rootName: text("root_name"),

    /**
     * The Frame IR itself, as an artifact.
     *
     * Cascade, not restrict. An export whose IR is gone records nothing —
     * every number on the row describes bytes that no longer exist. Restrict
     * also deadlocks the tenant cascade: dropping a project deletes its
     * artifacts, and a protected reference from here stops the whole delete.
     */
    irArtifactId: uuid("ir_artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),

    // --- health, at the moment of export -----------------------------------
    //
    // Promoted out of `summary` because these are the columns anyone filters
    // or sorts on. The rest of the summary stays in jsonb rather than growing
    // a column per metric the plugin invents.
    nodeCount: integer("node_count").notNull(),
    boundCount: integer("bound_count").notNull(),
    looseCount: integer("loose_count").notNull(),
    /** 0-100, as the Health tab reports it. The ceiling on everything after. */
    coveragePercent: real("coverage_percent").notNull(),
    schemaValid: boolean("schema_valid").notNull(),
    summary: jsonb("summary").notNull().default(sql`'{}'::jsonb`),

    /**
     * Structural and canonical signatures of the frame.
     *
     * These make "has this frame actually changed since last time" a cheap
     * indexed comparison instead of diffing two IR blobs. A designer who
     * re-exports after moving one label should not look like new work.
     */
    structuralSignature: text("structural_signature"),
    canonicalSignature: text("canonical_signature"),

    // --- lifecycle ----------------------------------------------------------
    status: exportStatus("status").notNull().default("received"),
    /**
     * Set when someone turns this export into pipeline work. Null while it is
     * only on the board.
     *
     * Nullable rather than implicit so both product shapes fit without a
     * migration: forward-everything can promote on arrival, and a curated
     * "send to pipeline" button can promote on click.
     */
    promotedRunId: uuid("promoted_run_id"),
    /** Which surface this frame was decided to be. Set at promotion, not before. */
    surfaceId: uuid("surface_id").references(() => surfaces.id, { onDelete: "set null" }),

    /**
     * Collapses a retried send into one event.
     *
     * Derived, not supplied: the plugin has no retry token, and a designer
     * pressing Send twice on a flaky connection must not produce two rows
     * claiming to be two exports. Built from the frame plus its Figma-side
     * timestamp — the same frame cannot be exported twice in the same
     * millisecond.
     */
    idempotencyKey: text("idempotency_key").notNull(),

    /** Figma-side clock, from the plugin. */
    exportedAt: timestamp("exported_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    exportedBy: text("exported_by"),
  },
  (t) => [
    uniqueIndex("figma_exports_project_idempotency_key").on(t.projectId, t.idempotencyKey),
    index("figma_exports_project_received_idx").on(t.projectId, t.receivedAt),
    // "show me the history of this one frame" — the query the board wants once
    // it stops being a 20-item buffer.
    index("figma_exports_frame_idx").on(t.projectId, t.rootNodeId, t.receivedAt),
    index("figma_exports_status_idx").on(t.projectId, t.status, t.receivedAt),
    index("figma_exports_ir_idx").on(t.irArtifactId),
  ],
);

/**
 * One section screenshot ("plate") per exported node.
 *
 * A table rather than a jsonb array because the pixel-diff gate needs to ask
 * "what is the reference image for node 1:4745". That lookup is exactly the
 * input C2 has been missing — the geometry check is skipped today because
 * nothing supplies reference images, and they have been arriving in every
 * export all along.
 */
export const figmaExportPlates = pgTable(
  "figma_export_plates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    exportId: uuid("export_id")
      .notNull()
      .references(() => figmaExports.id, { onDelete: "cascade" }),
    /**
     * Denormalised from the parent export, purely so this table can be synced.
     *
     * Electric filters one table with one `where` — it cannot join to reach the
     * export's tenant. Without this column the board could not stream plates at
     * all, or would have to stream every tenant's and filter client-side, which
     * is not a filter but a leak. Same reasoning as `runs.project_id`.
     */
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** The PNG, content-addressed like everything else. Cascade for the same
     * reason as the IR above: a plate row without its image is a dangling
     * caption. */
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    /** The Figma node this plate is a picture of. */
    nodeId: text("node_id").notNull(),
    name: text("name").notNull(),
    seq: integer("seq").notNull(),
  },
  (t) => [
    uniqueIndex("figma_export_plates_export_node_key").on(t.exportId, t.nodeId),
    index("figma_export_plates_node_idx").on(t.nodeId),
    index("figma_export_plates_project_idx").on(t.projectId),
  ],
);

// ---------------------------------------------------------------------------
// surfaces + versions — the only mutable entity, and it mutates by appending.
// ---------------------------------------------------------------------------

export const surfaces = pgTable(
  "surfaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Stable slug the client asks for, e.g. "player-card". Never changes. */
    key: text("key").notNull(),
    name: text("name").notNull(),
    /** Nullable FK set by the publish command. The only pointer clients read. */
    publishedVersionId: uuid("published_version_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("surfaces_project_key_key").on(t.projectId, t.key)],
);

export const surfaceVersions = pgTable(
  "surface_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    surfaceId: uuid("surface_id")
      .notNull()
      .references(() => surfaces.id, { onDelete: "cascade" }),
    /** Monotonic per surface, allocated under a row lock. Human-facing. */
    version: integer("version").notNull(),
    status: versionStatus("status").notNull().default("draft"),
    /** The compiled SDUI tree served to clients. */
    dslArtifactId: uuid("dsl_artifact_id").references(() => artifacts.id, { onDelete: "set null" }),
    /** The Figma IR it was compiled from — the provenance half of the pair. */
    irArtifactId: uuid("ir_artifact_id").references(() => artifacts.id, { onDelete: "set null" }),
    /** The run that produced it. Null for hand-authored versions. */
    sourceRunId: uuid("source_run_id"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("surface_versions_surface_version_key").on(t.surfaceId, t.version),
    index("surface_versions_surface_status_idx").on(t.surfaceId, t.status),
  ],
);

// ---------------------------------------------------------------------------
// runs — pipeline executions. Queued here, executed by the worker.
// ---------------------------------------------------------------------------

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    surfaceId: uuid("surface_id").references(() => surfaces.id, { onDelete: "set null" }),
    kind: runKind("kind").notNull(),
    status: runStatus("status").notNull().default("queued"),
    /** The command payload, verbatim. Replaying a run means re-reading this. */
    input: jsonb("input").notNull(),
    /** Caller-supplied key that collapses duplicate submissions into one run. */
    idempotencyKey: text("idempotency_key"),
    attempt: integer("attempt").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    error: jsonb("error"),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    requestedBy: text("requested_by"),
  },
  (t) => [
    uniqueIndex("runs_project_idempotency_key")
      .on(t.projectId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    index("runs_project_status_idx").on(t.projectId, t.status, t.queuedAt),
    index("runs_surface_idx").on(t.surfaceId, t.queuedAt),
  ],
);

export const runSteps = pgTable(
  "run_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    /** Position in the run's plan. Steps execute in ascending order. */
    seq: integer("seq").notNull(),
    name: text("name").notNull(),
    status: stepStatus("status").notNull().default("pending"),
    /** What this step produced, when it produced a blob. */
    outputArtifactId: uuid("output_artifact_id").references(() => artifacts.id, { onDelete: "set null" }),
    /** Step-local detail: timings, counts, the reason it was skipped. */
    detail: jsonb("detail").notNull().default(sql`'{}'::jsonb`),
    error: jsonb("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("run_steps_run_seq_key").on(t.runId, t.seq)],
);

// ---------------------------------------------------------------------------
// fidelity — the gate. One report per (run, version) attempt.
// ---------------------------------------------------------------------------

export const fidelityReports = pgTable(
  "fidelity_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    surfaceVersionId: uuid("surface_version_id")
      .notNull()
      .references(() => surfaceVersions.id, { onDelete: "cascade" }),
    passed: boolean("passed").notNull(),
    /** 0..1. Whatever @fanos/conform reports as the headline number. */
    score: real("score").notNull(),
    /** The thresholds in force at the time, so an old pass stays explicable. */
    thresholds: jsonb("thresholds").notNull(),
    /** Rule-level findings, already summarised. Full report lives in the artifact. */
    findings: jsonb("findings").notNull().default(sql`'[]'::jsonb`),
    reportArtifactId: uuid("report_artifact_id").references(() => artifacts.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("fidelity_reports_version_idx").on(t.surfaceVersionId, t.createdAt),
    uniqueIndex("fidelity_reports_run_version_key").on(t.runId, t.surfaceVersionId),
  ],
);

// ---------------------------------------------------------------------------
// audit_log — who did what. Cheap, append-only, and the reason we do not need
// event sourcing: it answers the audit question without owning the truth.
// ---------------------------------------------------------------------------

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    actor: text("actor").notNull(),
    /** Verb-shaped: "surface.published", "run.cancelled", "artifact.uploaded". */
    action: text("action").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    /** Only the fields that moved, not whole rows. */
    diff: jsonb("diff").notNull().default(sql`'{}'::jsonb`),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_log_project_at_idx").on(t.projectId, t.at),
    index("audit_log_subject_idx").on(t.subjectType, t.subjectId, t.at),
  ],
);

// ---------------------------------------------------------------------------
// relations — for drizzle's query API
// ---------------------------------------------------------------------------

export const projectsRelations = relations(projects, ({ many }) => ({
  artifacts: many(artifacts),
  surfaces: many(surfaces),
  runs: many(runs),
  figmaExports: many(figmaExports),
  figmaFiles: many(projectFigmaFiles),
}));

export const projectFigmaFilesRelations = relations(projectFigmaFiles, ({ one }) => ({
  project: one(projects, { fields: [projectFigmaFiles.projectId], references: [projects.id] }),
}));

export const figmaExportsRelations = relations(figmaExports, ({ one, many }) => ({
  project: one(projects, { fields: [figmaExports.projectId], references: [projects.id] }),
  irArtifact: one(artifacts, {
    fields: [figmaExports.irArtifactId],
    references: [artifacts.id],
  }),
  surface: one(surfaces, { fields: [figmaExports.surfaceId], references: [surfaces.id] }),
  plates: many(figmaExportPlates),
}));

export const figmaExportPlatesRelations = relations(figmaExportPlates, ({ one }) => ({
  export: one(figmaExports, {
    fields: [figmaExportPlates.exportId],
    references: [figmaExports.id],
  }),
  artifact: one(artifacts, {
    fields: [figmaExportPlates.artifactId],
    references: [artifacts.id],
  }),
}));

export const artifactsRelations = relations(artifacts, ({ one }) => ({
  project: one(projects, { fields: [artifacts.projectId], references: [projects.id] }),
}));

export const surfacesRelations = relations(surfaces, ({ one, many }) => ({
  project: one(projects, { fields: [surfaces.projectId], references: [projects.id] }),
  versions: many(surfaceVersions),
  publishedVersion: one(surfaceVersions, {
    fields: [surfaces.publishedVersionId],
    references: [surfaceVersions.id],
  }),
}));

export const surfaceVersionsRelations = relations(surfaceVersions, ({ one, many }) => ({
  surface: one(surfaces, { fields: [surfaceVersions.surfaceId], references: [surfaces.id] }),
  dslArtifact: one(artifacts, {
    fields: [surfaceVersions.dslArtifactId],
    references: [artifacts.id],
  }),
  irArtifact: one(artifacts, { fields: [surfaceVersions.irArtifactId], references: [artifacts.id] }),
  fidelityReports: many(fidelityReports),
}));

export const runsRelations = relations(runs, ({ one, many }) => ({
  project: one(projects, { fields: [runs.projectId], references: [projects.id] }),
  surface: one(surfaces, { fields: [runs.surfaceId], references: [surfaces.id] }),
  steps: many(runSteps),
}));

export const runStepsRelations = relations(runSteps, ({ one }) => ({
  run: one(runs, { fields: [runSteps.runId], references: [runs.id] }),
  outputArtifact: one(artifacts, {
    fields: [runSteps.outputArtifactId],
    references: [artifacts.id],
  }),
}));

export const fidelityReportsRelations = relations(fidelityReports, ({ one }) => ({
  run: one(runs, { fields: [fidelityReports.runId], references: [runs.id] }),
  surfaceVersion: one(surfaceVersions, {
    fields: [fidelityReports.surfaceVersionId],
    references: [surfaceVersions.id],
  }),
}));

/**
 * Row types, named `*Row` on purpose.
 *
 * These are persistence shapes, not domain types. Only adapters may name them;
 * a domain or app file importing one of these is the exact coupling the
 * architecture gate in `tests/architecture.test.ts` exists to catch.
 */
export type ProjectRow = typeof projects.$inferSelect;
export type ProjectFigmaFileRow = typeof projectFigmaFiles.$inferSelect;
export type FigmaExportRow = typeof figmaExports.$inferSelect;
export type FigmaExportPlateRow = typeof figmaExportPlates.$inferSelect;
export type ArtifactRow = typeof artifacts.$inferSelect;
export type SurfaceRow = typeof surfaces.$inferSelect;
export type SurfaceVersionRow = typeof surfaceVersions.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type RunStepRow = typeof runSteps.$inferSelect;
export type FidelityReportRow = typeof fidelityReports.$inferSelect;
