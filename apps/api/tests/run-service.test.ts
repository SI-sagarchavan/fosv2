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
import {
  FakeToolchain,
  brokenToolchain,
  fakeMeasurer,
  failingConform,
  unavailableMeasurer,
} from "./fakes/toolchain.js";

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
  return {
    irArtifact: ir.digest,
    themeArtifact: theme.digest,
    surfaceKey: "player-card",
    assets: [],
  };
}

async function boot(over: Parameters<typeof createTestApp>[0] = {}) {
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


/**
 * C2 is the only check that can see a layout error, and it only runs when boxes
 * reach it. The failure this guards against is not a wrong answer — it is a
 * gate that compares nothing and reports it as though everything were fine.
 */
describe("the geometry gate", () => {
  it("passes measured boxes and the root src to conform", async () => {
    const toolchain = new FakeToolchain();
    const input = await boot({
      toolchain,
      measurer: fakeMeasurer([{ id: "root", x: 0, y: 0, w: 240, h: 80 }]),
    });

    const run = await app.ctx.runs.start(projectId, { kind: "pipeline", input }, "tester");
    await app.ctx.runs.execute(run.id);

    expect(toolchain.lastConform?.boxes).toHaveLength(1);
    expect(toolchain.lastConform?.rootSrc).toBe("1:1");
  });

  it("records that geometry went unchecked, with the reason", async () => {
    const input = await boot({ measurer: unavailableMeasurer("chromium missing") });

    const run = await app.ctx.runs.start(projectId, { kind: "pipeline", input }, "tester");
    await app.ctx.runs.execute(run.id);

    const finished = await app.ctx.runs.get(projectId, run.id);
    const step = finished.steps?.find((s) => s.name === "conform");
    const geometry = (step?.detail as { geometry?: Record<string, unknown> }).geometry;

    expect(geometry?.measured).toBe(false);
    expect(geometry?.reason).toContain("chromium missing");
  });

  it("does not hand conform any boxes when measurement failed", async () => {
    const toolchain = new FakeToolchain();
    const input = await boot({ toolchain, measurer: unavailableMeasurer() });

    const run = await app.ctx.runs.start(projectId, { kind: "pipeline", input }, "tester");
    await app.ctx.runs.execute(run.id);

    expect(toolchain.lastConform?.boxes).toBeUndefined();
  });

  /**
   * A host with no browser must still produce a verdict on everything else. The
   * skip is recorded, not fatal — but it is recorded.
   */
  it("still completes the run when measurement is unavailable", async () => {
    const input = await boot({ measurer: unavailableMeasurer() });

    const run = await app.ctx.runs.start(projectId, { kind: "pipeline", input }, "tester");
    await app.ctx.runs.execute(run.id);

    const finished = await app.ctx.runs.get(projectId, run.id);
    expect(finished.status).toBe("succeeded");
    expect(finished.steps?.map((s) => s.name)).toContain("conform");
  });

  it("marks the stored report so a reader can tell silence from a pass", async () => {
    const input = await boot({ measurer: unavailableMeasurer("no chromium") });

    const run = await app.ctx.runs.start(projectId, { kind: "pipeline", input }, "tester");
    await app.ctx.runs.execute(run.id);

    const finished = await app.ctx.runs.get(projectId, run.id);
    const step = finished.steps?.find((s) => s.name === "conform");
    const artifact = await app.ctx.artifacts.download(projectId, step!.outputArtifactId!);
    const report = JSON.parse(new TextDecoder().decode(artifact.bytes)) as {
      measurement: { measured: boolean; reason?: string };
    };

    expect(report.measurement.measured).toBe(false);
    expect(report.measurement.reason).toBe("no chromium");
  });
});

/**
 * Fidelity and responsiveness are reported together on purpose: any layout
 * error can be driven to zero by pinning raw pixels, which buys a green gate by
 * making the tree correct at exactly one width.
 */
describe("what a run reports about the tree", () => {
  it("records drift magnitude, not just the error count", async () => {
    const input = await boot();
    const run = await app.ctx.runs.start(projectId, { kind: "pipeline", input }, "tester");
    await app.ctx.runs.execute(run.id);

    const finished = await app.ctx.runs.get(projectId, run.id);
    const geometry = (
      finished.steps?.find((s) => s.name === "conform")?.detail as {
        geometry?: Record<string, unknown>;
      }
    ).geometry;

    expect(geometry).toHaveProperty("totalDelta");
  });

  it("records pixel debt beside the tree that carries it", async () => {
    const input = await boot();
    const run = await app.ctx.runs.start(projectId, { kind: "pipeline", input }, "tester");
    await app.ctx.runs.execute(run.id);

    const finished = await app.ctx.runs.get(projectId, run.id);
    const metrics = (
      finished.steps?.find((s) => s.name === "compile")?.detail as {
        metrics?: Record<string, unknown>;
      }
    ).metrics;

    expect(metrics).toMatchObject({
      rawValues: expect.any(Number),
      rawPositions: expect.any(Number),
      tokenCoverage: expect.any(Number),
    });
  });
});

/**
 * The chain from "a designer marked an image" to "the renderer has a URL".
 *
 * The compiler emits `asset.texture.x` and nothing else — deliberately, so one
 * tree renders against a data URI in preview and an S3 object in production.
 * The run is the only place that knows which artifact holds those bytes, so if
 * it does not resolve the ref, nothing does.
 */
describe("marked background assets", () => {
  const marked = {
    tree: { schemaVersion: "1.0.0", nodes: [{ id: "root", type: "Box" }] },
    stats: { irNodes: 42, emitted: 30, absorbed: 12 },
    notes: [],
    requiredSurfaces: [],
    requiredAssets: [
      {
        name: "tickets_plate",
        ref: "asset.texture.tickets_plate",
        role: "background" as const,
        sourceId: "1:10",
        targetId: "1:2",
      },
    ],
    metrics: { rawValues: 0, rawPositions: 0, tokenCoverage: 1 },
  };

  /**
   * `boot` rebuilds the app and the project, so anything the run needs to find
   * has to be uploaded AFTER it — hence the callback rather than an argument.
   */
  async function runWith(
    seedAssets: () => Promise<Array<{ name: string; artifactId: string }>>,
  ) {
    const base = await boot({ toolchain: new FakeToolchain({ compile: () => marked }) });
    const assets = await seedAssets();

    const run = await app.ctx.runs.start(
      projectId,
      { kind: "pipeline", input: { ...base, assets } },
      "tester",
    );
    await app.ctx.runs.execute(run.id);
    return app.ctx.runs.get(projectId, run.id);
  }

  /** The surface set the run persisted, by value. */
  async function surfaceSetOf(finished: Awaited<ReturnType<typeof runWith>>) {
    const detail = finished.steps?.find((s) => s.name === "compile")?.detail as {
      surfaceSetArtifact?: string;
    };
    return app.ctx.artifacts.readJson<{ assets: Record<string, string> }>(
      projectId,
      detail.surfaceSetArtifact!,
    );
  }

  it("resolves a marked asset to its own bytes, not a stand-in", async () => {
    const finished = await runWith(async () => {
      const png = await app.ctx.artifacts.upload(
        projectId,
        {
          kind: "screenshot",
          base64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
          mediaType: "image/png",
          meta: {},
        },
        "tester",
      );
      return [{ name: "tickets_plate", artifactId: png.id }];
    });
    const set = await surfaceSetOf(finished);

    // Keyed by the BARE leaf, which is what the token registry looks up.
    expect(set.assets["texture.tickets_plate"]).toBe(
      `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64")}`,
    );

    const compile = finished.steps?.find((s) => s.name === "compile");
    expect(compile?.detail).toMatchObject({ unresolvedAssets: [] });
  });

  /**
   * The regression guard. This used to write one hardcoded tenant URL, so an
   * asset the run could not find rendered as a real — but completely wrong —
   * picture. Nothing in the trace said so, because as far as the pipeline was
   * concerned it had resolved.
   */
  it("leaves an asset it cannot resolve absent, and names it in the trace", async () => {
    const finished = await runWith(async () => []);
    const set = await surfaceSetOf(finished);

    expect(set.assets).toEqual({});

    const compile = finished.steps?.find((s) => s.name === "compile");
    expect(compile?.detail).toMatchObject({
      requiredAssets: ["asset.texture.tickets_plate"],
      unresolvedAssets: ["asset.texture.tickets_plate"],
    });
  });

  it("still succeeds — an unresolved background is not a failed run", async () => {
    const finished = await runWith(async () => []);
    expect(finished.status).toBe("succeeded");
  });
});
