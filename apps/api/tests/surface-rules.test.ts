/**
 * The publish rules, as pure functions.
 *
 * These are the most consequential rules in the system and, before the domain
 * was separated from Drizzle, the only way to check them was curl against a
 * live Postgres. Every case below used to require a database.
 */
import { describe, expect, it } from "vitest";

import {
  canPublish,
  nextVersionNumber,
  publishTransition,
  publishedCount,
  type Surface,
  type SurfaceVersion,
} from "../src/modules/surfaces/domain/surface.js";

const version = (over: Partial<SurfaceVersion> = {}): SurfaceVersion => ({
  id: "v1",
  surfaceId: "s1",
  version: 1,
  status: "candidate",
  dslArtifactId: "artifact-1",
  irArtifactId: "artifact-0",
  sourceRunId: "run-1",
  notes: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  createdBy: "tester",
  publishedAt: null,
  ...over,
});

const surface = (over: Partial<Surface> = {}): Surface => ({
  id: "s1",
  projectId: "p1",
  key: "player-card",
  name: "Player Card",
  publishedVersionId: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  archivedAt: null,
  ...over,
});

describe("canPublish", () => {
  it("allows a version whose gate passed", () => {
    const decision = canPublish(version(), { passed: true, score: 1 }, {
      overrideFidelityGate: false,
    });
    expect(decision).toEqual({ allowed: true, overrodeGate: false, gatePassed: true });
  });

  it("refuses a version whose gate failed", () => {
    const decision = canPublish(version(), { passed: false, score: 0.82 }, {
      overrideFidelityGate: false,
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.refusal.reason).toBe("gate-failed");
    expect(decision.refusal).toMatchObject({ score: 0.82 });
  });

  it("refuses a version that was never gated", () => {
    const decision = canPublish(version(), null, { overrideFidelityGate: false });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.refusal.reason).toBe("no-report");
  });

  it("allows a failed gate through an explicit override, and says so", () => {
    const decision = canPublish(version(), { passed: false, score: 0.4 }, {
      overrideFidelityGate: true,
    });
    expect(decision).toEqual({ allowed: true, overrodeGate: true, gatePassed: false });
  });

  it("allows an ungated version through an override, recording that it was ungated", () => {
    const decision = canPublish(version(), null, { overrideFidelityGate: true });
    expect(decision).toEqual({ allowed: true, overrodeGate: true, gatePassed: null });
  });

  /**
   * The asymmetry that matters: an override is a judgement call about fidelity,
   * not a way to publish something that would 500.
   */
  it("refuses a version with no tree even WITH an override", () => {
    const decision = canPublish(version({ dslArtifactId: null }), { passed: true, score: 1 }, {
      overrideFidelityGate: true,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.refusal.reason).toBe("no-tree");
  });

  it("checks for a tree before it checks the gate", () => {
    const decision = canPublish(version({ dslArtifactId: null }), null, {
      overrideFidelityGate: false,
    });
    // Not "no-report" — the missing tree is the more fundamental problem and
    // the one the operator should be told about.
    if (!decision.allowed) expect(decision.refusal.reason).toBe("no-tree");
  });
});

describe("nextVersionNumber", () => {
  it("starts at 1", () => {
    expect(nextVersionNumber([])).toBe(1);
  });

  it("continues from the highest, not the count", () => {
    expect(nextVersionNumber([1, 2, 3])).toBe(4);
  });

  it("does not reuse a number after a gap", () => {
    // Deleting v2 must not let a new version claim it — old artifacts and audit
    // entries still refer to "v2" and would silently point at different bytes.
    expect(nextVersionNumber([1, 3])).toBe(4);
  });

  it("is order-independent", () => {
    expect(nextVersionNumber([3, 1, 2])).toBe(4);
  });
});

describe("publishTransition", () => {
  it("archives the outgoing version and moves the pointer", () => {
    const transition = publishTransition(
      surface({ publishedVersionId: "v-old" }),
      version({ id: "v-new" }),
    );
    expect(transition).toEqual({ publish: "v-new", archive: "v-old", pointerTo: "v-new" });
  });

  it("archives nothing on a first publish", () => {
    const transition = publishTransition(surface(), version({ id: "v-new" }));
    expect(transition.archive).toBeNull();
  });

  it("does not archive the version it is re-publishing", () => {
    // Otherwise a no-op re-publish would archive the live version and leave the
    // surface pointing at an archived row.
    const transition = publishTransition(
      surface({ publishedVersionId: "v-same" }),
      version({ id: "v-same" }),
    );
    expect(transition.archive).toBeNull();
    expect(transition.pointerTo).toBe("v-same");
  });
});

describe("publishedCount", () => {
  it("counts only published versions", () => {
    expect(
      publishedCount([
        version({ id: "a", status: "archived" }),
        version({ id: "b", status: "published" }),
        version({ id: "c", status: "candidate" }),
      ]),
    ).toBe(1);
  });
});
