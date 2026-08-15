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
});

export type StudioPage = z.infer<typeof studioPageSchema>;
export type StudioExport = z.infer<typeof studioExportSchema>;
