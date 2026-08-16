/**
 * Ingest: the rules that decide what a valid export is, and what two sends of
 * the same frame mean.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  hasChangedFrom,
  healthOf,
  idempotencyKeyFor,
  IngestExportCommand,
} from "../src/modules/exports/domain/export.js";
import { createTestApp, type TestApp } from "./fakes/app.js";

const FILE_KEY = "FIGMA_FILE_ABC";

function command(over: Record<string, unknown> = {}) {
  return IngestExportCommand.parse({
    page: {
      fileKey: FILE_KEY,
      fileName: "Untitled",
      pageName: "Page 1",
      rootNodeId: "1:2",
      rootName: "D_Fixture",
    },
    at: 1786900000000,
    jsonName: "d-fixture.ir.json",
    ir: { root: { id: "1:2" } },
    summary: { nodeCount: 138, boundCount: 97, looseCount: 41, coveragePercent: 70.5 },
    screenshots: [{ name: "plate-1-2.png", nodeId: "1:2", bytesBase64: "aGVsbG8=" }],
    ...over,
  });
}

describe("idempotencyKeyFor", () => {
  it("is stable for the same send", () => {
    expect(idempotencyKeyFor(command())).toBe(idempotencyKeyFor(command()));
  });

  it("differs for the same frame exported later", () => {
    // Two sends a day apart are two real events, even if nothing changed.
    expect(idempotencyKeyFor(command())).not.toBe(idempotencyKeyFor(command({ at: 1786986400000 })));
  });

  it("differs per frame", () => {
    const other = command({
      page: {
        fileKey: FILE_KEY,
        fileName: "Untitled",
        pageName: "Page 1",
        rootNodeId: "9:9",
        rootName: "Other",
      },
    });
    expect(idempotencyKeyFor(command())).not.toBe(idempotencyKeyFor(other));
  });

  it("falls back to the frame name when Figma gives no node id", () => {
    const nameless = command({
      page: {
        fileKey: FILE_KEY,
        fileName: "Untitled",
        pageName: "Page 1",
        rootNodeId: null,
        rootName: "D_Fixture",
      },
    });
    expect(idempotencyKeyFor(nameless)).toContain("D_Fixture");
  });
});

describe("healthOf", () => {
  it("promotes the numbers the schema stores as columns", () => {
    expect(
      healthOf({ nodeCount: 138, boundCount: 97, looseCount: 41, coveragePercent: 70.5 }),
    ).toEqual({
      nodeCount: 138,
      boundCount: 97,
      looseCount: 41,
      coveragePercent: 70.5,
      schemaValid: true,
    });
  });

  it("treats a missing metric as zero rather than rejecting the export", () => {
    // A plugin version that stops reporting one number must not make frames
    // unsendable; the raw summary is stored alongside regardless.
    expect(healthOf({}).nodeCount).toBe(0);
  });

  it("only marks schema invalid when the plugin says so explicitly", () => {
    expect(healthOf({}).schemaValid).toBe(true);
    expect(healthOf({ schemaValid: false }).schemaValid).toBe(false);
  });
});

describe("hasChangedFrom", () => {
  it("sees an identical signature as unchanged", () => {
    expect(
      hasChangedFrom({ structuralSignature: "sig-1" }, { structuralSignature: "sig-1" }),
    ).toBe(false);
  });

  it("sees a different signature as changed", () => {
    expect(
      hasChangedFrom({ structuralSignature: "sig-1" }, { structuralSignature: "sig-2" }),
    ).toBe(true);
  });

  it("assumes changed when either signature is unknown", () => {
    // Silently claiming two frames are identical is the worse failure.
    expect(hasChangedFrom(null, { structuralSignature: "sig-1" })).toBe(true);
    expect(hasChangedFrom({ structuralSignature: "sig-1" }, {})).toBe(true);
  });
});

describe("ingest", () => {
  let app: TestApp;
  let projectId: string;

  beforeEach(async () => {
    app = createTestApp();
    projectId = await app.seedProject();
    await app.figmaFiles.claim(projectId, FILE_KEY);
  });

  it("stores the IR and every plate as artifacts, and records the event", async () => {
    const view = await app.ctx.exports.ingest(command(), "sagar");

    expect(view.rootName).toBe("D_Fixture");
    expect(view.health).toMatchObject({ nodeCount: 138, coveragePercent: 70.5 });
    expect(view.plates).toHaveLength(1);
    expect(view.deduplicated).toBe(false);

    const kinds = app.repos.artifacts.rows.map((a) => a.kind).sort();
    expect(kinds).toEqual(["figma_ir", "screenshot"]);
    expect(app.audit.actions()).toContain("export.received");
  });

  /** The property the whole schema is shaped around. */
  it("collapses a retried send, and stores the IR once", async () => {
    const first = await app.ctx.exports.ingest(command(), "sagar");
    const again = await app.ctx.exports.ingest(command(), "sagar");

    expect(again.id).toBe(first.id);
    expect(again.deduplicated).toBe(true);
    expect(app.repos.exports.rows).toHaveLength(1);
    expect(app.audit.actions().filter((a) => a === "export.received")).toHaveLength(1);
  });

  it("records a later send of an unchanged frame as a second event, sharing one IR", async () => {
    await app.ctx.exports.ingest(command(), "sagar");
    await app.ctx.exports.ingest(command({ at: 1786986400000 }), "sagar");

    expect(app.repos.exports.rows).toHaveLength(2);
    // Same bytes -> one artifact. This is the storage claim, asserted.
    expect(app.repos.artifacts.rows.filter((a) => a.kind === "figma_ir")).toHaveLength(1);
  });

  it("refuses a file that is not mapped to a project, storing nothing", async () => {
    const orphan = command({
      page: {
        fileKey: "UNCLAIMED",
        fileName: "Untitled",
        pageName: "Page 1",
        rootNodeId: "1:2",
        rootName: "D_Fixture",
      },
    });

    await expect(app.ctx.exports.ingest(orphan, "sagar")).rejects.toMatchObject({
      code: "unprocessable",
    });
    expect(app.repos.artifacts.rows).toHaveLength(0);
    expect(app.repos.exports.rows).toHaveLength(0);
  });

  it("refuses an unsaved Figma file with a fixable message", async () => {
    const local = command({
      page: {
        fileKey: null,
        fileName: "Untitled",
        pageName: "Page 1",
        rootNodeId: "1:2",
        rootName: "D",
      },
    });
    await expect(app.ctx.exports.ingest(local, "sagar")).rejects.toThrow(/save the file in Figma/);
  });

  it("rejects a malformed plate before storing any artifact", async () => {
    const bad = command({
      screenshots: [{ name: "broken.png", nodeId: "1:2", bytesBase64: "!!!not-base64!!!" }],
    });

    await expect(app.ctx.exports.ingest(bad, "sagar")).rejects.toMatchObject({
      code: "bad_request",
    });
    // Nothing half-written: encoding happens before the first store.
    expect(app.repos.artifacts.rows).toHaveLength(0);
  });

  it("keeps one tenant's exports out of another's list", async () => {
    await app.ctx.exports.ingest(command(), "sagar");
    const other = await app.ctx.projects.create({ slug: "other", name: "Other" }, "tester");

    expect(await app.ctx.exports.list(other.id, { limit: 50 })).toHaveLength(0);
    expect(await app.ctx.exports.list(projectId, { limit: 50 })).toHaveLength(1);
  });

  it("promotion is a separate act from receiving", async () => {
    const view = await app.ctx.exports.ingest(command(), "sagar");
    expect(view.status).toBe("received");

    const promoted = await app.ctx.exports.setStatus(
      projectId,
      view.id,
      "promoted",
      "sagar",
      "11111111-1111-1111-1111-111111111111",
    );

    expect(promoted.status).toBe("promoted");
    expect(promoted.promotedRunId).toBe("11111111-1111-1111-1111-111111111111");
    expect(app.audit.actions()).toContain("export.promoted");
  });
});
