/**
 * F2 — a stroke with no variable and no style behind it.
 *
 * PURE. No Figma import.
 */
import { paintRule } from "./paint.js";

export const unboundStroke = paintRule({
  id: "unbound-stroke",
  code: "F2",
  slot: "stroke",
  protects: "theming — a hardcoded border is the same colour for every tenant",
  message(kind, value) {
    switch (kind) {
      case "solid":
        return `Hardcoded ${value} on a border can't respond to a theme swap — every tenant gets this exact edge.`;
      case "gradient":
        return "A gradient stroke can't be re-themed. It needs a surface recipe authored before anything can bind to it.";
      case "image":
        return "An image stroke has no token behind it and can't be generated from the theme.";
      case "mixed":
        return "More than one stroke on one layer reads as no value at all, so nothing downstream can resolve this border.";
      default:
        return `${value} isn't a value the theme can resolve, so this border can't be generated with a token behind it.`;
    }
  },
});
