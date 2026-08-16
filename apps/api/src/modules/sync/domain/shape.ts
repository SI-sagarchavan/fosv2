/**
 * Shape requests, and the rule that keeps one tenant out of another's data.
 *
 * Electric serves whatever `where` clause it is handed. That makes the clause
 * a security boundary, not a filter — a client that could supply its own would
 * read every run in the database. So the client never supplies one: it names a
 * subject (`run`), and the scoping is derived here from ids the server already
 * resolved and authorized.
 *
 * Pure: no HTTP, no database. The interesting part is testable without either.
 */
import { z } from "zod";

/**
 * The only tables a client may sync, and how each is scoped.
 *
 * Two scoping shapes, not one:
 *
 *   - **run-scoped** — `runs`, `run_steps`. The client names a run; the service
 *     proves it belongs to the project before a shape is built.
 *   - **project-scoped** — `figma_exports`. The board watches a whole tenant,
 *     so there is no subject to authorize beyond the project itself.
 *
 * Widening from the first to the second is the riskier direction, which is why
 * the tables are enumerated rather than the scope being a parameter. A client
 * cannot ask for a project-scoped view of `runs`.
 */
export const RUN_SCOPED = ["runs", "run_steps"] as const;
export const PROJECT_SCOPED = ["figma_exports", "figma_export_plates"] as const;

export const SYNCABLE = [...RUN_SCOPED, ...PROJECT_SCOPED] as const;
export type SyncTable = (typeof SYNCABLE)[number];
export type RunScopedTable = (typeof RUN_SCOPED)[number];
export type ProjectScopedTable = (typeof PROJECT_SCOPED)[number];

export function isRunScoped(table: SyncTable): table is RunScopedTable {
  return (RUN_SCOPED as readonly string[]).includes(table);
}

/**
 * Cursor parameters, passed through verbatim.
 *
 * These are Electric's, not ours — `handle` identifies the shape instance and
 * `offset` the client's position in it. Together they are what lets a client
 * that closed its tab resume rather than restart, so they must survive the
 * proxy unmodified.
 */
export const SyncCursor = z.object({
  offset: z.string().default("-1"),
  handle: z.string().optional(),
  /** Long-poll for changes rather than returning immediately. */
  live: z.coerce.boolean().default(false),
  cursor: z.string().optional(),
});
export type SyncCursor = z.infer<typeof SyncCursor>;

export const SyncQuery = SyncCursor.extend({
  table: z.enum(SYNCABLE),
  /**
   * The run being watched. Required for run-scoped tables and rejected for
   * project-scoped ones — a client must not be able to widen or narrow the
   * scope by adding or dropping a parameter.
   */
  run: z.string().uuid().optional(),
}).superRefine((query, ctx) => {
  const needsRun = isRunScoped(query.table);
  if (needsRun && !query.run) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["run"],
      message: `table "${query.table}" is run-scoped and requires ?run=`,
    });
  }
  if (!needsRun && query.run) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["run"],
      message: `table "${query.table}" is project-scoped and takes no ?run=`,
    });
  }
});
export type SyncQuery = z.infer<typeof SyncQuery>;

export interface ShapeDefinition {
  table: SyncTable;
  where: string;
  params: Record<string, string>;
  cursor: SyncCursor;
}

/**
 * Build the scoped shape for a run the caller has already been authorized for.
 *
 * `runs` is additionally pinned to the project id even though the run id alone
 * is unique. Belt and braces: if a future caller resolves the run without
 * checking ownership, the shape still cannot cross a tenant boundary.
 */
export function shapeForRun(
  table: RunScopedTable,
  input: { runId: string; projectId: string; cursor: SyncCursor },
): ShapeDefinition {
  const { runId, projectId, cursor } = input;

  if (table === "runs") {
    return {
      table,
      where: '"id" = $1 AND "project_id" = $2',
      params: { "1": runId, "2": projectId },
      cursor,
    };
  }

  // run_steps carries no project_id. Its tenancy is inherited from the run,
  // which the service has already checked belongs to this project.
  return {
    table,
    where: '"run_id" = $1',
    params: { "1": runId },
    cursor,
  };
}

/**
 * Build a project-scoped shape.
 *
 * The board watches every export in a tenant, so the project id IS the whole
 * boundary — there is no narrower subject to authorize. That makes this the
 * more dangerous of the two builders, and the reason `PROJECT_SCOPED`
 * enumerates its tables rather than accepting a scope argument.
 */
export function shapeForProject(
  table: ProjectScopedTable,
  input: { projectId: string; cursor: SyncCursor },
): ShapeDefinition {
  return {
    table,
    where: '"project_id" = $1',
    params: { "1": input.projectId },
    cursor: input.cursor,
  };
}

/** Electric's query string for a shape. */
export function toSearchParams(shape: ShapeDefinition): URLSearchParams {
  const search = new URLSearchParams({
    table: shape.table,
    where: shape.where,
    offset: shape.cursor.offset,
  });

  for (const [key, value] of Object.entries(shape.params)) {
    search.set(`params[${key}]`, value);
  }
  if (shape.cursor.handle) search.set("handle", shape.cursor.handle);
  if (shape.cursor.live) search.set("live", "true");
  if (shape.cursor.cursor) search.set("cursor", shape.cursor.cursor);

  return search;
}

/**
 * Headers Electric uses to drive the client's cursor. They must reach the
 * browser intact or resumption silently degrades into a full refetch on every
 * reconnect.
 */
export const PASSTHROUGH_HEADERS = [
  "electric-handle",
  "electric-offset",
  "electric-schema",
  "electric-cursor",
  "electric-up-to-date",
  "electric-has-data",
  "content-type",
] as const;
