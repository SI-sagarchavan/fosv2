/**
 * The News page uses the SAME shared gallery rules as the Photos page, with no
 * changes to them at all — which is the point of writing them structurally.
 */
import { galleryRepairs } from "../_shared/gallery-repairs.mjs";

export const { repair } = galleryRepairs({
  dataRoot: "news",
  chrome: {
    News: "{news.title}",
    Home: "{news.breadcrumb}",
    "Load More": "{news.loadMore}",
    "LOAD MORE": "{news.loadMore}",
  },
});
