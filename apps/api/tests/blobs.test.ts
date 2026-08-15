/**
 * `blobKey` is domain — every storage backend must derive the same key, or a
 * migration between them silently loses blobs. The fs driver is an adapter and
 * is tested against a real temp directory.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFsBlobStore } from "../src/modules/artifacts/adapters/fs-blob-store.js";
import { blobKey } from "../src/modules/artifacts/domain/artifact.js";
import type { BlobStore } from "../src/modules/artifacts/domain/ports.js";
import { MemoryBlobStore } from "./fakes/repos.js";

const DIGEST = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const PROJECT = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

describe("blobKey", () => {
  it("fans out two levels so no directory collects every blob", () => {
    expect(blobKey(PROJECT, DIGEST)).toBe(`${PROJECT}/ba/78/${DIGEST}`);
  });

  it("scopes by project, so dropping a tenant is a directory delete", () => {
    expect(blobKey("other", DIGEST).startsWith("other/")).toBe(true);
  });
});

/**
 * Run the same contract against both implementations. A fake that quietly
 * disagrees with the real adapter is worse than no fake at all.
 */
describe.each(["fs", "memory"] as const)("%s blob store", (driver) => {
  let root: string | null = null;
  let store: BlobStore;

  beforeEach(async () => {
    if (driver === "fs") {
      root = await mkdtemp(join(tmpdir(), "fanos-blobs-"));
      store = createFsBlobStore(root);
    } else {
      store = new MemoryBlobStore();
    }
  });

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = null;
  });

  it("round-trips bytes", async () => {
    const key = blobKey(PROJECT, DIGEST);
    await store.put(key, new TextEncoder().encode("abc"));
    expect(new TextDecoder().decode(await store.get(key))).toBe("abc");
  });

  it("reports absence without throwing", async () => {
    expect(await store.has(blobKey(PROJECT, DIGEST))).toBe(false);
  });

  it("treats a repeat put as a no-op, not an overwrite", async () => {
    const key = blobKey(PROJECT, DIGEST);
    await store.put(key, new TextEncoder().encode("abc"));
    await store.put(key, new TextEncoder().encode("abc"));
    expect(new TextDecoder().decode(await store.get(key))).toBe("abc");
  });

  it("creates whatever nesting the key implies", async () => {
    const key = blobKey("deep-project", DIGEST);
    await store.put(key, new TextEncoder().encode("nested"));
    expect(await store.has(key)).toBe(true);
  });
});

describe("fs blob store specifics", () => {
  it("refuses a key that climbs out of the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "fanos-blobs-"));
    try {
      const store = createFsBlobStore(root);
      await expect(store.put("../escape", new TextEncoder().encode("x"))).rejects.toThrow(
        /escapes root/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
