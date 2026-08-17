/**
 * Marked backgrounds: from the bytes a designer sent to a URL the renderer can
 * fetch.
 *
 * The thing under test is a seam, not an algorithm. What matters is that the
 * compiled tree stays environment-free — it references `asset.texture.x` and
 * never a URL — and that an asset nobody can resolve comes back UNRESOLVED
 * instead of pointed at a stand-in.
 *
 * That second property is the regression guard. The previous behaviour attached
 * one hardcoded tenant URL to every asset in every project, so a designer could
 * mark any image at all and the page would render somebody else's listing
 * pattern. Silence is recoverable; a confident wrong picture is not.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  ArtifactUrlAssetPublisher,
  DataUriAssetPublisher,
  S3AssetPublisher,
} from "../src/modules/runs/adapters/asset-publishers.js";
import type { ArtifactAccess } from "../src/modules/runs/domain/ports.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

/** Just enough of the artifact store to feed a publisher. */
function store(rows: Record<string, { bytes: Uint8Array; mediaType: string }>): ArtifactAccess {
  return {
    async readBytes(_projectId, ref) {
      const row = rows[ref];
      if (!row) throw new Error(`no artifact ${ref}`);
      return row;
    },
    async readJson() {
      throw new Error("not used");
    },
    async store() {
      throw new Error("not used");
    },
  };
}

describe("DataUriAssetPublisher", () => {
  let artifacts: ArtifactAccess;

  beforeEach(() => {
    artifacts = store({ "art-1": { bytes: PNG, mediaType: "image/png" } });
  });

  it("inlines the bytes the designer actually marked", async () => {
    const publisher = new DataUriAssetPublisher(artifacts);
    const result = await publisher.publish("p1", [
      { name: "tickets_plate", ref: "asset.texture.tickets_plate", artifactId: "art-1" },
    ]);

    expect(result.unresolved).toEqual([]);
    expect(result.published).toEqual([
      {
        ref: "asset.texture.tickets_plate",
        url: `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`,
      },
    ]);
  });

  it("reports an asset with no artifact behind it rather than substituting one", async () => {
    const publisher = new DataUriAssetPublisher(artifacts);
    const result = await publisher.publish("p1", [
      { name: "ghost", ref: "asset.texture.ghost" },
    ]);

    expect(result.published).toEqual([]);
    expect(result.unresolved).toEqual(["asset.texture.ghost"]);
  });

  it("reports a missing blob rather than failing the whole run", async () => {
    const publisher = new DataUriAssetPublisher(artifacts);
    const result = await publisher.publish("p1", [
      { name: "gone", ref: "asset.texture.gone", artifactId: "art-404" },
    ]);

    expect(result.unresolved).toEqual(["asset.texture.gone"]);
  });

  /**
   * Base64 is ~4/3 of the file, and the surface set is JSON that every consumer
   * parses. An unbounded inline turns one careless 40 MB PNG into an artifact
   * nothing downstream can handle.
   */
  it("refuses an asset past the size ceiling", async () => {
    const big = new Uint8Array(1024);
    const publisher = new DataUriAssetPublisher(
      store({ "art-big": { bytes: big, mediaType: "image/png" } }),
      64,
    );
    const result = await publisher.publish("p1", [
      { name: "huge", ref: "asset.texture.huge", artifactId: "art-big" },
    ]);

    expect(result.published).toEqual([]);
    expect(result.unresolved).toEqual(["asset.texture.huge"]);
  });

  it("resolves each asset independently", async () => {
    const publisher = new DataUriAssetPublisher(artifacts);
    const result = await publisher.publish("p1", [
      { name: "good", ref: "asset.texture.good", artifactId: "art-1" },
      { name: "bad", ref: "asset.texture.bad", artifactId: "art-404" },
    ]);

    expect(result.published.map((a) => a.ref)).toEqual(["asset.texture.good"]);
    expect(result.unresolved).toEqual(["asset.texture.bad"]);
  });
});

describe("ArtifactUrlAssetPublisher", () => {
  it("points at the artifact's content endpoint", async () => {
    const publisher = new ArtifactUrlAssetPublisher("http://localhost:3000/");
    const result = await publisher.publish("p1", [
      { name: "plate", ref: "asset.texture.plate", artifactId: "art-1" },
    ]);

    expect(result.published).toEqual([
      { ref: "asset.texture.plate", url: "http://localhost:3000/v1/blobs/art-1" },
    ]);
  });

  it("reports an asset with no artifact, same as every other publisher", async () => {
    const publisher = new ArtifactUrlAssetPublisher("http://localhost:3000");
    const result = await publisher.publish("p1", [{ name: "ghost", ref: "asset.texture.ghost" }]);
    expect(result.unresolved).toEqual(["asset.texture.ghost"]);
  });
});

describe("S3AssetPublisher", () => {
  it("fails loudly rather than pretending to publish", () => {
    // The seam is recorded, not implemented. Throwing beats returning URLs to
    // objects nobody uploaded — those 404 at render time, a service away from
    // the cause.
    const publisher = new S3AssetPublisher(store({}), {
      bucket: "b",
      cdnBase: "https://cdn",
      region: "eu-west-1",
    });
    expect(() => publisher.publish()).toThrow(/not implemented/);
  });
});
