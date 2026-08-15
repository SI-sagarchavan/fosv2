/**
 * The Photos page uses the shared gallery rules. Only the data root and the
 * page's own copy differ — the rules themselves are untouched.
 */
import { galleryRepairs } from "../_shared/gallery-repairs.mjs";

export const { repair } = galleryRepairs({
  dataRoot: "photos",
  chrome: {
    Photos: "{photos.title}",
    Home: "{photos.breadcrumb}",
    "Load More": "{photos.loadMore}",
    "LOAD MORE": "{photos.loadMore}",
  },
});
