/**
 * The surface use cases, driven over in-memory adapters.
 *
 * Where `surface-rules.test.ts` checks the decisions, this checks that the
 * service actually applies them: that a refused publish leaves no trace, that
 * the invariant survives a sequence of publishes, that the audit entry records
 * an override honestly.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { AppError } from "../src/kernel/errors.js";
import { publishedCount } from "../src/modules/surfaces/domain/surface.js";
import { createTestApp, type TestApp } from "./fakes/app.js";

let app: TestApp;
let projectId: string;

async function seedVersion(opts: { gate?: "pass" | "fail" | "none"; tree?: boolean } = {}) {
  const artifact = await app.ctx.artifacts.upload(
    projectId,
    { kind: "dsl_tree", json: { nodes: [] }, meta: {} },
    "tester",
  );

  const version = await app.ctx.surfaces.createVersion(
    projectId,
    "player-card",
    { ...(opts.tree === false ? {} : { dslArtifact: artifact.id }) },
    "tester",
  );

  if (opts.gate && opts.gate !== "none") {
    await app.repos.fidelity.record({
      runId: "run-1",
      surfaceVersionId: version.id,
      passed: opts.gate === "pass",
      score: opts.gate === "pass" ? 1 : 0.5,
      thresholds: { maxErrors: 0, maxWarnings: null, minCoverage: 1 },
      findings: [],
      reportArtifactId: null,
    });
  }

  return version;
}

beforeEach(async () => {
  app = createTestApp();
  projectId = await app.seedProject();
  await app.ctx.surfaces.create(projectId, { key: "player-card", name: "Player Card" }, "tester");
});

describe("create", () => {
  it("refuses a duplicate key in the same project", async () => {
    await expect(
      app.ctx.surfaces.create(projectId, { key: "player-card", name: "Again" }, "tester"),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("allows the same key in a different project", async () => {
    const other = await app.ctx.projects.create({ slug: "other", name: "Other" }, "tester");
    const surface = await app.ctx.surfaces.create(
      other.id,
      { key: "player-card", name: "Player Card" },
      "tester",
    );
    expect(surface.key).toBe("player-card");
  });
});

describe("createVersion", () => {
  it("numbers versions from 1 upward", async () => {
    const first = await seedVersion();
    const second = await seedVersion();
    expect([first.version, second.version]).toEqual([1, 2]);
  });

  it("404s on an artifact ref that does not resolve", async () => {
    await expect(
      app.ctx.surfaces.createVersion(
        projectId,
        "player-card",
        { dslArtifact: "f".repeat(64) },
        "tester",
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("lists newest first", async () => {
    await seedVersion();
    await seedVersion();
    const versions = await app.ctx.surfaces.listVersions(projectId, "player-card");
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
  });
});

describe("publish", () => {
  it("goes live when the gate passed", async () => {
    const version = await seedVersion({ gate: "pass" });
    const surface = await app.ctx.surfaces.publish(
      projectId,
      "player-card",
      { version: version.version, overrideFidelityGate: false },
      "tester",
    );
    expect(surface.publishedVersion).toBe(1);
  });

  it("refuses when the gate failed, and changes nothing", async () => {
    const version = await seedVersion({ gate: "fail" });

    await expect(
      app.ctx.surfaces.publish(
        projectId,
        "player-card",
        { version: version.version, overrideFidelityGate: false },
        "tester",
      ),
    ).rejects.toBeInstanceOf(AppError);

    const surface = await app.ctx.surfaces.get(projectId, "player-card");
    expect(surface.publishedVersion).toBeNull();
    // No half-applied state, and nothing claiming a publish happened.
    expect(app.audit.actions()).not.toContain("surface.published");
    expect(publishedCount(app.repos.surfaces.versions)).toBe(0);
  });

  it("refuses a version with no tree even with an override", async () => {
    const version = await seedVersion({ gate: "pass", tree: false });
    await expect(
      app.ctx.surfaces.publish(
        projectId,
        "player-card",
        { version: version.version, overrideFidelityGate: true },
        "tester",
      ),
    ).rejects.toMatchObject({ code: "unprocessable" });
  });

  it("records an override honestly in the audit trail", async () => {
    const version = await seedVersion({ gate: "fail" });
    await app.ctx.surfaces.publish(
      projectId,
      "player-card",
      { version: version.version, overrideFidelityGate: true, reason: "launch is tomorrow" },
      "tester",
    );

    expect(app.audit.find("surface.published")?.diff).toMatchObject({
      overrodeFidelityGate: true,
      gatePassed: false,
      reason: "launch is tomorrow",
    });
  });

  /** The invariant that would be expensive to discover in production. */
  it("keeps exactly one published version across a sequence of publishes", async () => {
    const first = await seedVersion({ gate: "pass" });
    const second = await seedVersion({ gate: "pass" });
    const third = await seedVersion({ gate: "pass" });

    for (const v of [first, second, third, second]) {
      await app.ctx.surfaces.publish(
        projectId,
        "player-card",
        { version: v.version, overrideFidelityGate: false },
        "tester",
      );
      expect(publishedCount(app.repos.surfaces.versions)).toBe(1);
    }

    // Rolled back to v2 at the end.
    const surface = await app.ctx.surfaces.get(projectId, "player-card");
    expect(surface.publishedVersion).toBe(2);
  });

  it("stamps publishedAt from the injected clock, not the wall clock", async () => {
    app.clock.set(new Date("2026-03-01T12:00:00.000Z"));
    const version = await seedVersion({ gate: "pass" });
    await app.ctx.surfaces.publish(
      projectId,
      "player-card",
      { version: version.version, overrideFidelityGate: false },
      "tester",
    );

    const [published] = await app.ctx.surfaces.listVersions(projectId, "player-card");
    expect(published?.publishedAt).toBe("2026-03-01T12:00:00.000Z");
  });

  it("404s on a version that does not exist", async () => {
    await expect(
      app.ctx.surfaces.publish(
        projectId,
        "player-card",
        { version: 99, overrideFidelityGate: false },
        "tester",
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("live", () => {
  it("404s before anything is published", async () => {
    await expect(app.ctx.surfaces.live(projectId, "player-card")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("serves the published tree with its digest", async () => {
    const version = await seedVersion({ gate: "pass" });
    await app.ctx.surfaces.publish(
      projectId,
      "player-card",
      { version: version.version, overrideFidelityGate: false },
      "tester",
    );

    const live = await app.ctx.surfaces.live(projectId, "player-card");
    expect(live).toMatchObject({ key: "player-card", version: 1 });
    expect(live.tree).toEqual({ nodes: [] });
    expect(live.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("follows the pointer after a rollback", async () => {
    const first = await seedVersion({ gate: "pass" });
    const second = await seedVersion({ gate: "pass" });

    for (const v of [second, first]) {
      await app.ctx.surfaces.publish(
        projectId,
        "player-card",
        { version: v.version, overrideFidelityGate: false },
        "tester",
      );
    }

    expect((await app.ctx.surfaces.live(projectId, "player-card")).version).toBe(1);
  });
});
