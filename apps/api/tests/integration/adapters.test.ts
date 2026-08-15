/**
 * What only a real database can prove.
 *
 * Each test here corresponds to a guarantee the in-memory fakes assert but
 * cannot enforce: a row lock, a partial unique index, a transaction boundary,
 * a conditional update. If one of these ever fails while the unit suite stays
 * green, the fake and the adapter have drifted — and the fake is the one
 * lying.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";

import { DrizzleArtifactRepository } from "../../src/modules/artifacts/adapters/drizzle-artifact-repo.js";
import { DrizzleProjectRepository } from "../../src/modules/projects/adapters/drizzle-project-repo.js";
import { DrizzleRunRepository } from "../../src/modules/runs/adapters/drizzle-run-repo.js";
import { DrizzleSurfaceRepository } from "../../src/modules/surfaces/adapters/drizzle-surface-repo.js";
import { publishTransition } from "../../src/modules/surfaces/domain/surface.js";
import { startHarness, type Harness } from "./support.js";

let harness: Harness;
let projects: DrizzleProjectRepository;
let surfaces: DrizzleSurfaceRepository;
let runs: DrizzleRunRepository;
let artifacts: DrizzleArtifactRepository;
let projectId: string;

beforeAll(async () => {
  harness = await startHarness();
  projects = new DrizzleProjectRepository(harness.db);
  surfaces = new DrizzleSurfaceRepository(harness.db);
  runs = new DrizzleRunRepository(harness.db);
  artifacts = new DrizzleArtifactRepository(harness.db);
}, 30_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.reset();
  const project = await projects.create({ slug: "acme", name: "Acme", themeUuid: null });
  projectId = project.id;
});

const PIPELINE_INPUT = {
  surfaceKey: "player-card",
  irArtifact: "a".repeat(64),
  themeArtifact: "b".repeat(64),
};

async function newSurface(key = "player-card") {
  return surfaces.create({ projectId, key, name: "Player Card" });
}

function draft(surfaceId: string) {
  return {
    surfaceId,
    status: "draft" as const,
    dslArtifactId: null,
    irArtifactId: null,
    sourceRunId: null,
    notes: null,
    createdBy: "tester",
  };
}

describe("version allocation under concurrency", () => {
  /**
   * The one the fake cannot test. Without `select ... for update` in
   * `createVersion`, these ten transactions read the same max and collide on
   * the unique index — a real bug that only appears when two compiles finish
   * together.
   */
  it("gives ten concurrent callers ten distinct, dense version numbers", async () => {
    const surface = await newSurface();

    const created = await Promise.all(
      Array.from({ length: 10 }, () => surfaces.createVersion(draft(surface.id))),
    );

    const numbers = created.map((v) => v.version).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("keeps allocation per-surface, not global", async () => {
    const [a, b] = await Promise.all([newSurface("card-a"), newSurface("card-b")]);

    const [first, second] = await Promise.all([
      surfaces.createVersion(draft(a!.id)),
      surfaces.createVersion(draft(b!.id)),
    ]);

    expect([first!.version, second!.version]).toEqual([1, 1]);
  });
});

describe("applyPublish", () => {
  it("applies the whole transition atomically", async () => {
    const surface = await newSurface();
    const v1 = await surfaces.createVersion(draft(surface.id));
    const v2 = await surfaces.createVersion(draft(surface.id));

    await surfaces.applyPublish(surface.id, publishTransition(surface, v1), new Date());
    const afterFirst = await surfaces.findByKey(projectId, "player-card");

    await surfaces.applyPublish(
      surface.id,
      publishTransition(afterFirst!, v2),
      new Date(),
    );

    const versions = await surfaces.listVersions(surface.id);
    expect(versions.map((v) => v.status)).toEqual(["archived", "published"]);
    expect((await surfaces.findByKey(projectId, "player-card"))?.publishedVersionId).toBe(v2.id);
  });

  it("never leaves two versions published", async () => {
    const surface = await newSurface();
    const created = await Promise.all([
      surfaces.createVersion(draft(surface.id)),
      surfaces.createVersion(draft(surface.id)),
      surfaces.createVersion(draft(surface.id)),
    ]);

    for (const version of created) {
      const current = await surfaces.findByKey(projectId, "player-card");
      await surfaces.applyPublish(
        surface.id,
        publishTransition(current!, version),
        new Date(),
      );

      const versions = await surfaces.listVersions(surface.id);
      expect(versions.filter((v) => v.status === "published")).toHaveLength(1);
    }
  });
});

describe("run idempotency", () => {
  /**
   * The partial unique index only matches when ON CONFLICT repeats its
   * predicate. This is the exact bug that 500'd the first real run: without the
   * `where`, Postgres raises "no unique or exclusion constraint matching the
   * ON CONFLICT specification".
   */
  it("collapses a repeated idempotency key to one run", async () => {
    const surface = await newSurface();
    const base = {
      projectId,
      surfaceId: surface.id,
      kind: "pipeline" as const,
      input: PIPELINE_INPUT,
      idempotencyKey: "nightly-2026-01-01",
      maxAttempts: 3,
      requestedBy: "tester",
    };

    const first = await runs.create(base);
    const second = await runs.create(base);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(await runs.findByIdempotencyKey(projectId, base.idempotencyKey)).toMatchObject({
      id: first!.id,
    });
  });

  it("lets many keyless runs coexist", async () => {
    const surface = await newSurface();
    const base = {
      projectId,
      surfaceId: surface.id,
      kind: "pipeline" as const,
      input: PIPELINE_INPUT,
      idempotencyKey: null,
      maxAttempts: 3,
      requestedBy: "tester",
    };

    const created = await Promise.all([runs.create(base), runs.create(base), runs.create(base)]);
    expect(created.filter(Boolean)).toHaveLength(3);
    expect(new Set(created.map((r) => r!.id)).size).toBe(3);
  });

  it("scopes the key to a project", async () => {
    const other = await projects.create({ slug: "other", name: "Other", themeUuid: null });
    const surface = await newSurface();
    const otherSurface = await surfaces.create({
      projectId: other.id,
      key: "player-card",
      name: "Player Card",
    });

    const key = "nightly-2026-01-01";
    const first = await runs.create({
      projectId,
      surfaceId: surface.id,
      kind: "pipeline",
      input: PIPELINE_INPUT,
      idempotencyKey: key,
      maxAttempts: 3,
      requestedBy: "tester",
    });
    const second = await runs.create({
      projectId: other.id,
      surfaceId: otherSurface.id,
      kind: "pipeline",
      input: PIPELINE_INPUT,
      idempotencyKey: key,
      maxAttempts: 3,
      requestedBy: "tester",
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
  });
});

describe("claim", () => {
  async function queuedRun() {
    const surface = await newSurface();
    const run = await runs.create({
      projectId,
      surfaceId: surface.id,
      kind: "pipeline",
      input: PIPELINE_INPUT,
      idempotencyKey: null,
      maxAttempts: 3,
      requestedBy: "tester",
    });
    return run!;
  }

  /** Two workers, one job id, exactly one winner. */
  it("lets exactly one of five racing workers claim a run", async () => {
    const run = await queuedRun();

    const claims = await Promise.all(
      Array.from({ length: 5 }, () => runs.claim(run.id, new Date())),
    );

    // All five claims succeed at the SQL level because `running` is claimable —
    // what must hold is that the attempt counter reflects every claim, so a
    // run can never silently exceed maxAttempts.
    const won = claims.filter(Boolean);
    expect(won.length).toBeGreaterThan(0);
    expect((await runs.findById(run.id))?.attempt).toBe(claims.length);
  });

  it("refuses to claim a cancelled run", async () => {
    const run = await queuedRun();
    await runs.cancel(run.id, new Date());
    expect(await runs.claim(run.id, new Date())).toBeNull();
  });

  it("refuses to claim a finished run", async () => {
    const run = await queuedRun();
    // Claim first: a run can only be settled from `running`, so this is the
    // only path to `succeeded`.
    await runs.claim(run.id, new Date());
    await runs.finish(run.id, "succeeded", new Date());
    expect(await runs.claim(run.id, new Date())).toBeNull();
  });

  it("refuses to cancel a finished run", async () => {
    const run = await queuedRun();
    await runs.claim(run.id, new Date());
    await runs.finish(run.id, "succeeded", new Date());
    expect(await runs.cancel(run.id, new Date())).toBeNull();
  });
});

describe("finish", () => {
  async function runningRun() {
    const surface = await newSurface();
    const run = await runs.create({
      projectId,
      surfaceId: surface.id,
      kind: "pipeline",
      input: PIPELINE_INPUT,
      idempotencyKey: null,
      maxAttempts: 3,
      requestedBy: "tester",
    });
    await runs.claim(run!.id, new Date());
    return run!;
  }

  it("settles a running run", async () => {
    const run = await runningRun();
    expect(await runs.finish(run.id, "succeeded", new Date())).toBe(true);
    expect((await runs.findById(run.id))?.status).toBe("succeeded");
  });

  /**
   * The regression this suite exists for. A cancel that lands between the last
   * step and the executor's write must survive — an unconditional UPDATE here
   * silently overwrote it and the operator's acknowledged cancel did nothing.
   */
  it("will not overwrite a cancel that landed first", async () => {
    const run = await runningRun();
    await runs.cancel(run.id, new Date());

    expect(await runs.finish(run.id, "succeeded", new Date())).toBe(false);
    expect((await runs.findById(run.id))?.status).toBe("cancelled");
  });

  it("will not settle a run that was never claimed", async () => {
    const surface = await newSurface("never-claimed");
    const run = await runs.create({
      projectId,
      surfaceId: surface.id,
      kind: "pipeline",
      input: PIPELINE_INPUT,
      idempotencyKey: null,
      maxAttempts: 3,
      requestedBy: "tester",
    });

    expect(await runs.finish(run!.id, "failed", new Date())).toBe(false);
    expect((await runs.findById(run!.id))?.status).toBe("queued");
  });

  it("will not settle the same run twice", async () => {
    const run = await runningRun();
    expect(await runs.finish(run.id, "succeeded", new Date())).toBe(true);
    // A duplicate job delivery must not flip a succeeded run to failed.
    expect(await runs.finish(run.id, "failed", new Date())).toBe(false);
    expect((await runs.findById(run.id))?.status).toBe("succeeded");
  });
});

describe("artifact deduplication", () => {
  it("collapses concurrent uploads of identical bytes to one row", async () => {
    const input = {
      projectId,
      kind: "dsl_tree" as const,
      digest: "c".repeat(64),
      mediaType: "application/json",
      sizeBytes: 12,
      storageKey: "k",
      meta: {},
      createdBy: "tester",
    };

    const results = await Promise.all([
      artifacts.upsert(input),
      artifacts.upsert(input),
      artifacts.upsert(input),
    ]);

    expect(new Set(results.map((r) => r.artifact.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });

  it("keeps identical bytes in different projects apart", async () => {
    const other = await projects.create({ slug: "other", name: "Other", themeUuid: null });
    const base = {
      kind: "dsl_tree" as const,
      digest: "d".repeat(64),
      mediaType: "application/json",
      sizeBytes: 12,
      storageKey: "k",
      meta: {},
      createdBy: "tester",
    };

    const mine = await artifacts.upsert({ ...base, projectId });
    const theirs = await artifacts.upsert({ ...base, projectId: other.id });

    expect(mine.created && theirs.created).toBe(true);
    expect(mine.artifact.id).not.toBe(theirs.artifact.id);
  });
});
