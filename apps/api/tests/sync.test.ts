/**
 * The sync scoping rules.
 *
 * Electric serves whatever `where` clause it is handed, which makes that clause
 * a security boundary rather than a filter. These tests exist because the
 * failure mode is not a crash — it is one tenant quietly streaming another's
 * runs, which nothing else in the system would notice.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { shapeForRun, toSearchParams, SyncQuery } from "../src/modules/sync/domain/shape.js";
import { createTestApp, type TestApp } from "./fakes/app.js";

const RUN = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const PROJECT = "9c960e15-5e34-47bd-b4b2-2c04ecb4c1aa";

describe("shapeForRun", () => {
  it("pins runs to both the run id and the project", () => {
    const shape = shapeForRun("runs", {
      runId: RUN,
      projectId: PROJECT,
      cursor: { offset: "-1", live: false },
    });

    expect(shape.where).toBe('"id" = $1 AND "project_id" = $2');
    expect(shape.params).toEqual({ "1": RUN, "2": PROJECT });
  });

  it("scopes run_steps through the run, which the service has already checked", () => {
    const shape = shapeForRun("run_steps", {
      runId: RUN,
      projectId: PROJECT,
      cursor: { offset: "-1", live: false },
    });

    expect(shape.where).toBe('"run_id" = $1');
    expect(shape.params).toEqual({ "1": RUN });
  });

  it("never emits an unfiltered shape", () => {
    for (const table of ["runs", "run_steps"] as const) {
      const shape = shapeForRun(table, {
        runId: RUN,
        projectId: PROJECT,
        cursor: { offset: "-1", live: false },
      });
      expect(shape.where).not.toBe("");
      expect(Object.keys(shape.params).length).toBeGreaterThan(0);
    }
  });

  it("passes ids as bound parameters, not interpolated into the clause", () => {
    // A run id that reached the where clause as text would be an injection
    // point into Electric's parser.
    const shape = shapeForRun("runs", {
      runId: "'; drop table runs; --",
      projectId: PROJECT,
      cursor: { offset: "-1", live: false },
    });

    expect(shape.where).not.toContain("drop table");
    expect(shape.params["1"]).toBe("'; drop table runs; --");
  });
});

describe("toSearchParams", () => {
  const base = { runId: RUN, projectId: PROJECT };

  it("carries the cursor so a reconnecting client resumes", () => {
    const search = toSearchParams(
      shapeForRun("runs", { ...base, cursor: { offset: "1234_5", handle: "h-9", live: true } }),
    );

    expect(search.get("offset")).toBe("1234_5");
    expect(search.get("handle")).toBe("h-9");
    expect(search.get("live")).toBe("true");
  });

  it("omits handle and live on a first subscription", () => {
    const search = toSearchParams(
      shapeForRun("runs", { ...base, cursor: { offset: "-1", live: false } }),
    );

    expect(search.get("offset")).toBe("-1");
    expect(search.has("handle")).toBe(false);
    expect(search.has("live")).toBe(false);
  });

  it("binds params in Electric's params[n] form", () => {
    const search = toSearchParams(
      shapeForRun("runs", { ...base, cursor: { offset: "-1", live: false } }),
    );

    expect(search.get("params[1]")).toBe(RUN);
    expect(search.get("params[2]")).toBe(PROJECT);
  });
});

describe("SyncQuery", () => {
  it("rejects a table that is not syncable", () => {
    expect(() => SyncQuery.parse({ table: "artifacts", run: RUN })).toThrow();
  });

  it("requires a run — a whole table is never syncable", () => {
    expect(() => SyncQuery.parse({ table: "runs" })).toThrow();
  });

  it("defaults to a fresh, non-live subscription", () => {
    const query = SyncQuery.parse({ table: "runs", run: RUN });
    expect(query).toMatchObject({ offset: "-1", live: false });
  });
});

describe("SyncService", () => {
  let app: TestApp;
  let projectId: string;
  let runId: string;

  beforeEach(async () => {
    app = createTestApp();
    projectId = await app.seedProject();
    await app.ctx.surfaces.create(projectId, { key: "news-page", name: "News" }, "tester");

    const ir = await app.ctx.artifacts.upload(
      projectId,
      { kind: "figma_ir", json: { root: {} }, meta: {} },
      "tester",
    );
    const theme = await app.ctx.artifacts.upload(
      projectId,
      { kind: "token_set", json: { tokens: {} }, meta: {} },
      "tester",
    );

    const run = await app.ctx.runs.start(
      projectId,
      {
        kind: "pipeline",
        input: {
          surfaceKey: "news-page",
          irArtifact: ir.digest,
          themeArtifact: theme.digest,
        },
      },
      "tester",
    );
    runId = run.id;
  });

  it("forwards a scoped shape for a run in the project", async () => {
    const response = await app.ctx.sync.shape(projectId, {
      table: "runs",
      run: runId,
      offset: "-1",
      live: false,
    });

    expect(response.status).toBe(200);
    expect(app.syncGateway.requests).toHaveLength(1);
    expect(app.syncGateway.requests[0]).toMatchObject({
      table: "runs",
      params: { "1": runId, "2": projectId },
    });
  });

  /** The check that matters: a guessed run id from another tenant. */
  it("404s a run belonging to another project, and calls Electric not at all", async () => {
    const other = await app.ctx.projects.create({ slug: "other", name: "Other" }, "tester");

    await expect(
      app.ctx.sync.shape(other.id, { table: "runs", run: runId, offset: "-1", live: false }),
    ).rejects.toMatchObject({ code: "not_found" });

    expect(app.syncGateway.requests).toHaveLength(0);
  });

  it("404s a run that does not exist", async () => {
    await expect(
      app.ctx.sync.shape(projectId, { table: "runs", run: RUN, offset: "-1", live: false }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("relays the cursor headers a client needs to resume", async () => {
    const response = await app.ctx.sync.shape(projectId, {
      table: "run_steps",
      run: runId,
      offset: "0_0",
      handle: "h-1",
      live: true,
    });

    expect(response.headers).toMatchObject({
      "electric-handle": expect.any(String),
      "electric-offset": expect.any(String),
    });
  });
});
