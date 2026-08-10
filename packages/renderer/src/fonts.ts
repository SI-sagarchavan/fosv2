/**
 * Self-hosted font faces for the headless harness.
 *
 * Bakbak One (400) and Montserrat (400/500/700) must be preloaded. A font
 * fallback swap makes every text metric wrong and the diff score meaningless.
 *
 * Fonts live in `public/fonts/`. The harness injects these @font-face rules
 * and waits on `document.fonts.ready` before screenshotting.
 */

export const FONT_FACE_CSS = `
@font-face {
  font-family: "Bakbak One";
  font-style: normal;
  font-weight: 400;
  font-display: block;
  src: url("/public/fonts/bakbak-one-400.woff2") format("woff2");
}
@font-face {
  font-family: "Montserrat";
  font-style: normal;
  font-weight: 400;
  font-display: block;
  src: url("/public/fonts/montserrat-400.woff2") format("woff2");
}
@font-face {
  font-family: "Montserrat";
  font-style: normal;
  font-weight: 500;
  font-display: block;
  src: url("/public/fonts/montserrat-500.woff2") format("woff2");
}
@font-face {
  font-family: "Montserrat";
  font-style: normal;
  font-weight: 700;
  font-display: block;
  src: url("/public/fonts/montserrat-700.woff2") format("woff2");
}
`;

/** Families the harness asserts are loaded (not fallbacks). */
export const REQUIRED_FONTS = ["Bakbak One", "Montserrat"] as const;
