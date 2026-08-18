/**
 * The body the Figma plugin posts to POST /v1/exports.
 * Kept here, not imported from the plugin package — that package also
 * ships Figma typings and the IR library, which this app must not pull in.
 */
import { z } from "zod";

export const studioPageSchema = z.object({
  fileKey: z.string().nullable(),
  fileName: z.string(),
  pageName: z.string(),
  rootNodeId: z.string().nullable(),
  rootName: z.string().nullable(),
});

export const studioExportSchema = z.object({
  page: studioPageSchema,
  at: z.number(),
  jsonName: z.string(),
  ir: z.unknown(),
  summary: z.record(z.unknown()),
  screenshots: z.array(
    z.object({
      name: z.string(),
      nodeId: z.string(),
      bytesBase64: z.string(),
    }),
  ),
  assets: z
    .array(
      z.object({
        name: z.string(),
        nodeId: z.string(),
        targetNodeId: z.string(),
        role: z.literal("background"),
        /**
         * `original` — the bytes out of Figma's image store. `rendered` — the
         * node re-exported as a PNG because the original was unreachable.
         * Optional: a plugin build from before this field still posts.
         */
        source: z.enum(["original", "rendered"]).optional(),
        bytesBase64: z.string(),
      }),
    )
    .optional()
    .default([]),
});

/**
 * What the plugin sends to see what a frame compiles to.
 *
 * Everything travels by value — the IR, the theme, the marked bytes — because
 * a preview must not depend on anything having been uploaded. The whole point
 * is answering "what will this look like?" before an export exists.
 */
export const previewRequestSchema = z.object({
  ir: z.unknown(),
  /** The raw theme file, as the plugin has it compiled in. */
  theme: z.unknown(),
  assets: z
    .array(z.object({ name: z.string().min(1), bytesBase64: z.string() }))
    .max(64)
    .optional()
    .default([]),
  width: z.number().int().positive().max(4000).optional(),
  /**
   * A sample payload the tree's `{path}` bindings resolve against.
   *
   * Optional, and inert on a freshly compiled tree: the compiler emits Figma's
   * literal characters on purpose, so there is nothing to fill until something
   * has bound the tree. It matters for the step after that — a bound tree
   * rendered without a bag shows `{section.title}` to the designer, which looks
   * like a broken preview rather than a missing argument.
   */
  data: z.record(z.unknown()).optional(),
});
export type PreviewRequest = z.infer<typeof previewRequestSchema>;

/**
 * What the board sends to start a compile.
 *
 * The client supplies only what it already has on screen from the synced row.
 * Everything else the run needs — the theme artifact, the surface record — is
 * resolved server-side, because those are control-plane facts the board has no
 * business guessing at.
 */
export const compileRequestSchema = z.object({
  exportId: z.string().uuid(),
  irArtifact: z.string().min(1),
  surfaceKey: z
    .string()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "surface key must be lowercase kebab-case"),
  surfaceName: z.string().min(1).max(200),
  /**
   * Start a fresh run instead of returning the existing one.
   *
   * Normally the idempotency key makes a second click free. But the inputs a
   * run depends on — the theme, the compiler itself — change underneath a
   * fixed export, and then "you already compiled this" is the wrong answer.
   */
  force: z.boolean().default(false),
});

export type StudioPage = z.infer<typeof studioPageSchema>;
export type StudioExport = z.infer<typeof studioExportSchema>;
export type CompileRequest = z.infer<typeof compileRequestSchema>;
