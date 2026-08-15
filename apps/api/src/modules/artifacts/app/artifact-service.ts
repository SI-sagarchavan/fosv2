/**
 * Artifact use cases. Bytes in, content address out.
 *
 * The ordering rule survives the refactor unchanged and is worth restating:
 * **blob first, row second, always**. A blob with no row is garbage a sweeper
 * can collect; a row with no blob is a broken artifact that breaks reads. We
 * always leave the recoverable failure, never the corrupting one.
 *
 * Also satisfies the `ArtifactLookup` port that surfaces and runs declare —
 * structurally, without either module importing this class.
 */
import type { AuditSink } from "../../../kernel/audit.js";
import { AppError } from "../../../kernel/errors.js";
import { canonicalJson, digestOf, isDigest } from "../../../kernel/hash.js";
import {
  DEFAULT_MEDIA_TYPE,
  blobKey,
  toArtifactView,
  type Artifact,
  type ArtifactKind,
  type ArtifactView,
  type ListArtifactsQuery,
  type UploadArtifactCommand,
} from "../domain/artifact.js";
import type { ArtifactRepository, BlobStore } from "../domain/ports.js";

export interface ArtifactServiceDeps {
  repo: ArtifactRepository;
  blobs: BlobStore;
  audit: AuditSink;
}

export class ArtifactService {
  constructor(private readonly deps: ArtifactServiceDeps) {}

  async upload(
    projectId: string,
    command: UploadArtifactCommand,
    actor: string,
  ): Promise<ArtifactView> {
    const bytes = materialise(command);
    const digest = digestOf(bytes);

    if (command.expectedDigest && command.expectedDigest !== digest) {
      throw AppError.unprocessable("digest mismatch", {
        expected: command.expectedDigest,
        actual: digest,
      });
    }

    return this.store(projectId, {
      kind: command.kind,
      bytes,
      digest,
      ...(command.mediaType ? { mediaType: command.mediaType } : {}),
      meta: command.meta,
      actor,
    });
  }

  /** The internal entry point — the pipeline persists step output through here. */
  async store(
    projectId: string,
    input: {
      kind: ArtifactKind;
      bytes: Uint8Array;
      digest?: string;
      mediaType?: string;
      meta?: Record<string, unknown>;
      actor?: string;
    },
  ): Promise<ArtifactView> {
    const digest = input.digest ?? digestOf(input.bytes);
    const key = blobKey(projectId, digest);

    await this.deps.blobs.put(key, input.bytes);

    const { artifact, created } = await this.deps.repo.upsert({
      projectId,
      kind: input.kind,
      digest,
      mediaType: input.mediaType ?? DEFAULT_MEDIA_TYPE[input.kind],
      sizeBytes: input.bytes.byteLength,
      storageKey: key,
      meta: input.meta ?? {},
      createdBy: input.actor ?? null,
    });

    if (created) {
      await this.deps.audit.record({
        projectId,
        actor: input.actor ?? "system",
        action: "artifact.uploaded",
        subjectType: "artifact",
        subjectId: artifact.id,
        diff: { kind: artifact.kind, digest, sizeBytes: artifact.sizeBytes },
      });
    }

    return { ...toArtifactView(artifact), deduplicated: !created };
  }

  async get(projectId: string, ref: string): Promise<ArtifactView> {
    return toArtifactView(await this.require(projectId, ref));
  }

  async list(projectId: string, query: ListArtifactsQuery): Promise<ArtifactView[]> {
    const artifacts = await this.deps.repo.list(projectId, {
      ...(query.kind ? { kind: query.kind } : {}),
      limit: query.limit,
      ...(query.before ? { before: new Date(query.before) } : {}),
    });
    return artifacts.map(toArtifactView);
  }

  /** Bytes plus media type, for the download route. */
  async download(
    projectId: string,
    ref: string,
  ): Promise<{ artifact: ArtifactView; bytes: Uint8Array }> {
    const artifact = await this.require(projectId, ref);
    const bytes = await this.deps.blobs.get(artifact.storageKey).catch(() => {
      throw AppError.internal(`blob missing for artifact ${artifact.id}`);
    });
    return { artifact: toArtifactView(artifact), bytes };
  }

  // --- the ArtifactLookup port, satisfied structurally ----------------------

  async resolveId(projectId: string, ref: string): Promise<string> {
    return (await this.require(projectId, ref)).id;
  }

  async digestOf(projectId: string, ref: string): Promise<string> {
    return (await this.require(projectId, ref)).digest;
  }

  async readJson<T = unknown>(projectId: string, ref: string): Promise<T> {
    const { artifact, bytes } = await this.download(projectId, ref);
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as T;
    } catch {
      throw AppError.unprocessable(`artifact ${artifact.id} is not valid JSON`);
    }
  }

  /** Accepts either a uuid or a digest — callers hold whichever they have. */
  private async require(projectId: string, ref: string): Promise<Artifact> {
    const found = isDigest(ref)
      ? await this.deps.repo.findByDigest(projectId, ref)
      : await this.deps.repo.findById(projectId, ref);
    if (!found) throw AppError.notFound("artifact", ref);
    return found;
  }
}

function materialise(command: UploadArtifactCommand): Uint8Array {
  const hasJson = command.json !== undefined;
  const hasBase64 = command.base64 !== undefined;

  if (hasJson === hasBase64) {
    throw AppError.badRequest("provide exactly one of `json` or `base64`");
  }
  if (hasBase64) {
    return base64ToBytes(command.base64 as string);
  }
  // Canonical form, so two callers who serialise the same tree differently
  // still land on one artifact.
  return new TextEncoder().encode(canonicalJson(command.json));
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
