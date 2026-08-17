/**
 * Where a marked background's bytes live, as far as the renderer is concerned.
 *
 * Three answers, one port. The compiled tree references `asset.texture.x` and
 * never a URL, so the same artifact renders against a data URI in a preview, an
 * API URL in the board, and an S3 object in production — chosen by config, not
 * by regenerating the tree.
 *
 * Before this existed the answer was a constant: every marked asset in every
 * project resolved to one hardcoded tenant URL. A designer could mark whatever
 * they liked and the page rendered somebody else's listing pattern, which is
 * the worst possible failure mode because it looks like it worked.
 *
 * All three refuse to guess. An asset whose bytes cannot be found comes back
 * `unresolved`, and the pipeline records that on the run.
 */
import { AppError } from "../../../kernel/errors.js";
import type {
  ArtifactAccess,
  AssetPublisher,
  PublishableAsset,
  PublishedAsset,
} from "../domain/ports.js";

/**
 * Inline the bytes as a `data:` URI.
 *
 * The default, and what makes a run self-contained: the surface set carries
 * everything needed to paint the page, so a preview, the Playwright harness and
 * an offline reader all resolve without reaching the control plane. Base64 is
 * ~4/3 the size of the file, so this is bounded — past the cap an asset is
 * reported unresolved rather than quietly producing a surface-set artifact tens
 * of megabytes wide that every consumer then has to parse.
 */
export class DataUriAssetPublisher implements AssetPublisher {
  constructor(
    private readonly artifacts: ArtifactAccess,
    /** Per-asset ceiling on the ENCODED length. Default 4 MB of base64 (~3 MB of PNG). */
    private readonly maxEncodedBytes = 4 * 1024 * 1024,
  ) {}

  async publish(
    projectId: string,
    assets: readonly PublishableAsset[],
  ): Promise<{ published: PublishedAsset[]; unresolved: string[] }> {
    const published: PublishedAsset[] = [];
    const unresolved: string[] = [];

    for (const asset of assets) {
      if (!asset.artifactId) {
        unresolved.push(asset.ref);
        continue;
      }
      try {
        const { bytes, mediaType } = await this.artifacts.readBytes(projectId, asset.artifactId);
        const encoded = Buffer.from(bytes).toString("base64");
        if (encoded.length > this.maxEncodedBytes) {
          unresolved.push(asset.ref);
          continue;
        }
        published.push({ ref: asset.ref, url: `data:${mediaType};base64,${encoded}` });
      } catch {
        // A missing blob is a broken artifact, not a reason to fail the run —
        // the tree is still worth producing, and the run records what is absent.
        unresolved.push(asset.ref);
      }
    }

    return { published, unresolved };
  }
}

/**
 * Point at the artifact's own content endpoint.
 *
 * Keeps the surface set small and the bytes content-addressed where they
 * already are, which is the closest thing to the production shape without
 * object storage: the URL is stable because an artifact is immutable. The cost
 * is that whoever renders must be able to reach the API and authenticate —
 * Surface Studio proxies it at `/v1/blobs/:ref` for exactly that reason.
 */
export class ArtifactUrlAssetPublisher implements AssetPublisher {
  /** @param baseUrl origin the renderer can reach, e.g. `http://localhost:3000` */
  constructor(private readonly baseUrl: string) {}

  async publish(
    projectId: string,
    assets: readonly PublishableAsset[],
  ): Promise<{ published: PublishedAsset[]; unresolved: string[] }> {
    const published: PublishedAsset[] = [];
    const unresolved: string[] = [];
    const base = this.baseUrl.replace(/\/+$/, "");

    for (const asset of assets) {
      if (!asset.artifactId) {
        unresolved.push(asset.ref);
        continue;
      }
      published.push({
        ref: asset.ref,
        url: `${base}/v1/blobs/${encodeURIComponent(asset.artifactId)}`,
      });
    }

    // Deliberately not fetched to confirm. A HEAD per asset per run buys very
    // little — the artifact row exists or ingest would have failed — and makes
    // every compile wait on the network.
    void projectId;
    return { published, unresolved };
  }
}

/**
 * Object storage. The production answer, and the reason the port is shaped this
 * way rather than the pipeline reading bytes itself.
 *
 * Not wired yet: it needs a bucket, a credential chain and a CDN hostname, none
 * of which exist in this environment. The shape is recorded here so the change
 * is a constructor swap in `context.ts` rather than a rewrite of the compile
 * step — and so nobody re-introduces a hardcoded URL in the meantime.
 *
 * Implementation sketch:
 *
 *   1. key = `${projectId}/textures/${digestOf(artifactId)}.png` — content
 *      addressed, so re-running a compile uploads nothing and the URL is
 *      permanently cacheable.
 *   2. `HeadObject`; upload only on a miss.
 *   3. return `${cdnBase}/${key}`.
 *
 * The digest is already on the artifact, so step 1 needs no extra read.
 */
export class S3AssetPublisher implements AssetPublisher {
  constructor(
    private readonly _artifacts: ArtifactAccess,
    private readonly _config: { bucket: string; cdnBase: string; region: string },
  ) {}

  publish(): Promise<{ published: PublishedAsset[]; unresolved: string[] }> {
    void this._artifacts;
    void this._config;
    throw AppError.internal(
      "S3AssetPublisher is not implemented — set ASSET_PUBLISHER=data-uri or artifact-url",
    );
  }
}
