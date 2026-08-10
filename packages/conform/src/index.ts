/**
 * @fanos/conform — the fidelity gate.
 *
 * `@fanos/dsl` answers "is this tree legal". This answers "is this tree true to
 * the Figma frame it claims to come from".
 */

export { conform } from "./conform.js";
export type { ConformOptions } from "./conform.js";

export { CODE_TITLES, CONFORM_CODES, issuesByCode } from "./issues.js";
export type {
  ConformCode,
  ConformIssue,
  ConformResult,
  ConformSummary,
  Severity,
} from "./issues.js";

export { ancestorsOf, indexIr, isDescendantOf, offsetWithin, paints } from "./ir-index.js";
export type { IrIndex } from "./ir-index.js";

export { checkCoverage } from "./checks/coverage.js";
export { checkGeometry } from "./checks/geometry.js";
export type { GeometryOptions, GeometryResult, NodeBox } from "./checks/geometry.js";
export { checkSizing } from "./checks/sizing.js";
export { checkSnapping } from "./checks/snapping.js";
export { checkSrc } from "./checks/src.js";

export { formatReport } from "./report.js";
export { sliceIr } from "./slice.js";
