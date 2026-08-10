/**
 * @fanos/renderer — web SDUI renderer + visual diff harness.
 *
 * Seven node types: Box, Stack, Overlay, Text, Image, Icon, Divider.
 * Every component is a Server Component. No "use client".
 */

// Pure resolvers
export { resolveAnchor } from "./resolve/anchor.js";
export type { PlaceInput, CssProperties } from "./resolve/anchor.js";
export { resolveNode, resolveTone, resolveGradient } from "./resolve/style.js";
export type { StyleContext, ResolvedNodeStyle } from "./resolve/style.js";
export { resolveValue, resolveResp, resolveDuration, applyRespProp, markRaw } from "./resolve/value.js";
export type { ResolvedValue, BreakpointValues } from "./resolve/value.js";
export { interpolate, lookup, formatUnresolvedWarnings } from "./resolve/data.js";
export type { DataBag, InterpolateResult } from "./resolve/data.js";

// Components
export { Render } from "./components/Render.js";
export type { RenderProps } from "./components/Render.js";
export { Box } from "./components/Box.js";
export { Stack } from "./components/Stack.js";
export { Overlay } from "./components/Overlay.js";
export { Text } from "./components/Text.js";
export { Image } from "./components/Image.js";
export { Icon } from "./components/Icon.js";
export { Divider } from "./components/Divider.js";

// Harness
export { measureNodeBoxes, renderToPng, writePng, closeBrowser } from "./harness/renderToPng.js";
export type { MeasuredBox, RenderToPngOptions } from "./harness/renderToPng.js";
export { diff, findRegions } from "./harness/diff.js";
export type { DiffResult, DiffRegion } from "./harness/diff.js";
export { mapRegionsToNodes, COLLECT_NODE_BOXES_SCRIPT } from "./harness/mapRegions.js";
export type { NodeBox, RegionNodes } from "./harness/mapRegions.js";

// Fonts
export { FONT_FACE_CSS, REQUIRED_FONTS } from "./fonts.js";

// Context
export type { RenderConfig, NodeRenderContext } from "./context.js";
