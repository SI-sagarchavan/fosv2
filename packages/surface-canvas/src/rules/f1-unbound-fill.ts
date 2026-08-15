/**
 * F1 — a fill with no variable and no style behind it.
 *
 * PURE. No Figma import.
 *
 * The largest single category of loose value on a real page, and the largest
 * single lever on the score.
 */
import { paintRule } from "./paint.js";

export const unboundFill = paintRule({
  id: "unbound-fill",
  code: "F1",
  slot: "fill",
  protects: "theming — a hardcoded fill is the same colour for every tenant",
  message(kind, value) {
    switch (kind) {
      case "solid":
        return `Hardcoded ${value} can't respond to a theme swap — this layer stays ${value} for every tenant.`;
      case "gradient":
        return "A hardcoded gradient can't be re-themed or re-used. It needs a surface recipe authored before anything can bind to it.";
      case "image":
        return "An image fill is content, not a token — it stays outside the theme and outside the score you can move.";
      case "mixed":
        return "More than one fill on one layer reads as no value at all, so nothing downstream can resolve this colour.";
      default:
        return `${value} isn't a value the theme can resolve, so this layer can't be generated with a token behind it.`;
    }
  },
});
