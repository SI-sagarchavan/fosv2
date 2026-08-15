/**
 * Filesystem adapter for `BlobStore`.
 *
 * The key layout is not decided here — `blobKey` in the domain owns it, so an
 * S3 adapter pointed at the same content derives the same key and a migration
 * between the two is a copy rather than a rewrite.
 */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { BlobStore } from "../domain/ports.js";

export function createFsBlobStore(root: string): BlobStore {
  const base = resolve(root);

  const pathFor = (key: string): string => {
    const full = resolve(join(base, key));
    // Keys are derived from digests we generated, but never trust a path built
    // from a string that crossed the wire.
    if (full !== base && !full.startsWith(base + "/")) {
      throw new Error(`blob key escapes root: ${key}`);
    }
    return full;
  };

  return {
    async put(key, bytes) {
      const path = pathFor(key);
      if (await exists(path)) return;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes, { flag: "wx" }).catch((err: NodeJS.ErrnoException) => {
        // Two runs racing on the same digest is expected and harmless — the
        // bytes are identical by construction.
        if (err.code !== "EEXIST") throw err;
      });
    },

    get(key) {
      return readFile(pathFor(key));
    },

    has(key) {
      return exists(pathFor(key));
    },
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
