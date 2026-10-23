/**
 * TEMPORARY — named static datasets, read off disk.
 *
 *   GET /v1/data          -> the names available
 *   GET /v1/data/:name    -> that dataset's JSON
 *
 * This is scaffolding, and it should be deleted rather than grown.
 *
 * The real arrangement is an artifact: content-addressed, immutable, recorded
 * on the run that used it, so a screenshot taken six months ago can be
 * reproduced against the exact bytes it was taken against. That is already
 * built — `sample_data` artifacts work today and the preview accepts one.
 *
 * What an artifact cannot do is be EDITED. Every keystroke means re-uploading
 * and getting a new UUID, which is fine for a pipeline and miserable for the
 * hour you spend deciding what the copy should say. So: a folder of JSON, read
 * at request time, addressed by a name a person can type.
 *
 * Deliberately narrow, so the temptation to keep it stays small:
 *   - read-only. Nothing here writes. Editing means editing the file.
 *   - no project scoping, no auth story of its own, no versioning.
 *   - `../` cannot escape the folder, because a path built from a query string
 *     is never trusted however temporary the code around it is.
 */
import { readFile, readdir } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { AppError } from "../../../kernel/errors.js";

/**
 * `apps/api/data`, relative to the running process rather than to this file.
 *
 * `dist/` and `src/` sit at different depths, so resolving from `import.meta`
 * would find the folder in dev and miss it in a build. The API is always
 * started from its own package root — every other path in the config, including
 * `BLOB_ROOT=./.blobs`, already assumes that.
 */
const DATA_DIR = resolve(process.cwd(), "data");

/** A file name, not a path. Anything with a separator or a dot is refused. */
const Name = z.object({ name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "not a dataset name") });

export async function registerDataRoutes(app: FastifyInstance): Promise<void> {
  app.get("/data", async () => {
    const files = await readdir(DATA_DIR).catch(() => [] as string[]);
    return {
      datasets: files.filter((f) => extname(f) === ".json").map((f) => basename(f, ".json")).sort(),
      note: "temporary static datasets — the durable form is a sample_data artifact",
    };
  });

  app.get("/data/:name", async (request) => {
    const { name } = Name.parse(request.params);

    const path = join(DATA_DIR, `${name}.json`);
    // Belt and braces: the regex already forbids separators, but a path built
    // from a query string gets checked where it is used, not where it is parsed.
    if (!resolve(path).startsWith(DATA_DIR + "/")) {
      throw AppError.notFound("dataset", name);
    }

    const raw = await readFile(path, "utf8").catch(() => null);
    if (raw === null) throw AppError.notFound("dataset", name);

    try {
      return JSON.parse(raw) as unknown;
    } catch (err) {
      // A half-typed JSON file is the normal state of this folder while someone
      // is editing it. Say which file and what is wrong with it.
      throw AppError.badRequest(`dataset "${name}" is not valid JSON: ${(err as Error).message}`);
    }
  });
}
