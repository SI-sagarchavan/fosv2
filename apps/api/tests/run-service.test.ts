/**
 * The run state machine, driven end to end over fakes.
 *
 * With the toolchain behind a port, the awkward paths are one line each: a
 * compile that throws permanently, a cancel that lands mid-run, a job delivered
 * twice. None of these were reachable in a test before.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { shouldGiveUp } from "../src/modules/runs/domain/run.js";
import { createTestApp, type TestApp } from "./fakes/app.js";
import { FakeToolchain, brokenToolchain, failingConform } from "./fakes/toolchain.js";

let app: TestApp;
let projectId: string;

async function seedInputs() {
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
  return { irArtifact: ir.digest, themeArtifact: theme.digest, surfaceKey: "player-card" };
}

async function boot(over: { toolchain?: TestApp["toolchain"] } = {}) {
  app = createTestApp(over);
  projectId = await app.seedProject();
  await app.ctx.surfaces.create(projectId, { key: "player-card", name: "Player Card" }, "tester");
  return seedInputs();
}

beforeEach(async () => {
  await boot();
});

describe("start", () => {
  it("queues a run and plans its steps", async () => {
    const input = await seedInputs();
    const run = await app.ctx.runs.start(projectId, { kind: "pipeline", input }, "tester");

    expect(run.status).toBe("queued");
    expect(app.queue.jobs).toEqual([{ runId: run.id, projectId }]);

    const steps = await app.repos.runs.listSteps(run.id);
    expect(steps.map((s) => s.name)).toEqual(["load-inputs", "compile", "version", "conform"]);
    expect(steps.every((s) => s.status === "pending")).toBe(true);
  });

  it("404s on an unknown surface before writing anything", async () => {
    const input = { ...(await seedInputs()), surfaceKey: "does-not-exist" };
    await expect(
      app.ctx.runs.start(projectId, { kind: "pipeline", input }, "tester"),
    ).rejects.toMatchObject({ code: "not_found" });

    expect(app.repos.runs.runs).toHaveLength(0);
    expect(app.queue.jobs).toHaveLength(0);
  });

  it("returns the original run for a repeated idempotency key", async () => {
    const input = await seedInputs();
    const command = { kind: "pipeline" as const, input, idempotencyKey: "nightly-2026-01-01" };

    const first = await app.ctx.runs.start(projectId, command, "tester");
    const second = await app.ctx.runs.start(projectId, command, "tester");

    expect(second.id).toBe(first.id);
    expect(app.repos.runs.runs).toHaveLength(1);
    // Critically, no second job — otherwise the pipeline runs twice.
    expect(app.queue.jobs).toHaveLength(1);
  });

  it("treats keyless runs as distinct", async () => {
    const input = await seedInputs();
    const first = await app.ctx.runs.start(projectId, { kind: "pipeline", input }, "tester");
    const second = await app.ctx.runs.start(projectId, { kind: "pipeline", input }, "tester");
    expect(second.id).not.toBe(first.id);
  });

  it("refuses a run kind with no plan", async () => {
    const input = await seedInputs();
    await expect(
      app.ctx.runs.start(projectId, { kind: "render", input }, "tester"),
    ).rejects.toMatchObject({ code: "unprocessable" });
  });
});

describe("execute", () => {
  it("walks the plan and records each step", async () => {
    const input = await seedInputs();
    const run = await app.ctx.runs.start(projectId, { kind: "pipeline", input }, "tester");
    await app.ctx.runs.execute(run.id);

    const finished = await app.ctx.runs.get(projectId, run.id);
    expect(finished.status).toBe("succeeded");
    expect(finished.steps?.map((s) => s.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
    ]);

    // The compile step produced an artifact and the trace points at it.
    const compile = finished.steps?.find((s) => s.name === "compile");
    expect(compile?.outputArtifactId).toBeTruthy();
    expect(compile?.detail).toMatchObject({ stats: { irNodes: 42 } });
  });

  it("creates a candidate version carrying the run id", async () => {
    const input = await seedInputs();
    const run = await app.ctx.runs.start(projectId, { kind: "pipeline", input }, "tester");
    await app.ctx.runs.execute(run.id);

    const [version] = await app.ctx.surfaces.listVersions(projectId, "player-card");
    expect(version).toMatchObject({ version: 1, status: "candidate", sourceRunId: run.id });
  });

  /** The rule that keeps a bad design from becoming a retry storm. */
  it("succeeds even when the fidelity gate fails", async () => {
    const input = await boot({ toolchain: new FakeToolchain({ conform: failingConform }) });
    const run = await app.ctx.runs.start(projectId, { kind: "pipeline", input }, "tester");
    await app.ctx.runs.execute(run.id);

    const finished = await app.ctx.runs.get(projectId, run.id);
    expect(finished.status).toBe("succeeded");

    // The run produced a verdict; the verdict is what blocks publishing.
    const [version] = await app.ctx.surfaces.listVersions(projectId, "player-card");
    const report = await app.ctx.fidelity.latestForVersion(version!.id);
    expect(report?.passed).toBe(false);
  });

  it("fails the run and skips the rest when a step throws", async () => {
    const input = await boot({ toolchain: brokenToolchain("permanent") });
    const run = await app.ctx.runs.start(projectId, { kind: "pipeline", input }, "tester");

    await expect(app.ctx.runs.execute(run.id)).rejects.toThrow();

    const finished = await app.ctx.runs.get(projectId, run.id);
    expect(finished.status).toBe("failed");
    expect(finished.steps?.map((s) => s.status)).toEqual([
      "succeeded",
      "failed",
      "skipped",
      "skipped",
    ]);
    // No step is left dangling in `pending`.
    expect(finished.steps?.some((s) => s.status === "pending")).toBe(false);
  });

  it("gives up immediately on a permanent failure rather than burning attempts", async () => {
    const input = await boot({ toolchain: brokenToolchain("permanent") });
    const run = await app.ctx.runs.start(projectId, { kind: "pipeline", input }, "tester");
    await expect(app.ctx.runs.execute(run.id)).rejects.toThrow();

    const finished = await app.ctx.runs.get(projectId, run.id);
    expect(finished.status).toBe("failed");
    expect(finished.attempt).toBe(1);
  });

  it("leaves a transient failure retryable until attempts run out", async () => {
    const input = await boot({ toolchain: brokenToolchain("transient") });
    const run = await app.ctx.runs.start(projectId, { kind: "pipeline", input }, "tester");

    await expect(app.ctx.runs.execute(run.id)).rejects.toThrow();
    // Still claimable — the queue will hand it back.
    expect((await app.repos.runs.findById(run.id))?.status).toBe("running");

    await expect(app.ctx.runs.execute(run.id)).rejects.toThrow();
    await expect(app.ctx.runs.execute(run.id)).rejects.toThrow();

    const exhausted = await app.ctx.runs.get(projectId, run.id);
    expect(exhausted.status).toBe("failed");
    expect(exhausted.attempt).toBe(3);
  });

  it("stops mid-plan when a cancel lands, without marking the run failed", async () => {
    const input = await seedInputs();
    const run = await app.ctx.runs.start(projectId, { kind: "pipeline", input }, "tester");
    await app.ctx.runs.cancel(projectId, run.id, "tester");

    // Must not throw: cancellation is a decision, not an error.
    await expect(app.ctx.runs.execute(run.id)).resolves.toBeUndefined();
    expect((await app.repos.runs.findById(run.id))?.status).toBe("cancelled");
  });

  /**
   * Regression. The pipeline is fast, so a cancel routinely lands *between* the
   * last step starting and the executor writing its outcome. `finish` used to
   * be an unconditional update, so the completing run overwrote `cancelled`
   * with `succeeded`: the operator got a 200 from the cancel, and the run
   * finished and published a version anyway.
   */
  it("does not overwrite a cancel that lands during the final step", async () => {
    const input = await seedInputs();
    const run = await app.ctx.runs.start(projectId, { kind: "pipeline", input }, "tester");

    // Claim it the way the worker would, then cancel underneath the executor.
    await app.repos.runs.claim(run.id, app.clock.now());
    await app.repos.runs.cancel(run.id, app.clock.now());

    // The executor tries to settle a run that is no longer running.
    const settled = await app.repos.runs.finish(run.id, "succeeded", app.clock.now());

    expect(settled).toBe(false);
    expect((await app.repos.runs.findById(run.id))?.status).toBe("cancelled");
  });

  it("refuses to settle a run that never started", async () => {
    const input = await seedInputs();
    const run = await app.ctx.runs.start(projectId, { kind: "pipeline", input }, "tester");
    // Still `queued` — nothing claimed it, so nothing may settle it.
    expect(await app.repos.runs.finish(run.id, "failed", app.clock.now())).toBe(false);
  });

  it("ignores a job for a run that already finished", async () => {
    const input = await seedInputs();
    const run = await app.ctx.runs.start(projectId, { kind: "pipeline", input }, "tester");
    await app.ctx.runs.execute(run.id);

    // A duplicate delivery must not re-run the pipeline and mint a second version.
    await app.ctx.runs.execute(run.id);
    expect(await app.ctx.surfaces.listVersions(projectId, "player-card")).toHaveLength(1);
  });
});

describe("cancel", () => {
  it("refuses to cancel a finished run", async () => {
    const input = await seedInputs();
    const run = await app.ctx.runs.start(projectId, { kind: "pipeline", input }, "tester");
    await app.ctx.runs.execute(run.id);

    await expect(app.ctx.runs.cancel(projectId, run.id, "tester")).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("404s across project boundaries", async () => {
    const input = await seedInputs();
    const run = await app.ctx.runs.start(projectId, { kind: "pipeline", input }, "tester");
    const other = await app.ctx.projects.create({ slug: "other", name: "Other" }, "tester");

    await expect(app.ctx.runs.cancel(other.id, run.id, "tester")).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("shouldGiveUp", () => {
  it("gives up on a permanent failure regardless of attempts left", () => {
    expect(shouldGiveUp({ permanent: true, attempt: 1, maxAttempts: 3 })).toBe(true);
  });

  it("retries a transient failure with attempts left", () => {
    expect(shouldGiveUp({ permanent: false, attempt: 1, maxAttempts: 3 })).toBe(false);
  });

  it("gives up once attempts are exhausted", () => {
    expect(shouldGiveUp({ permanent: false, attempt: 3, maxAttempts: 3 })).toBe(true);
  });
});
