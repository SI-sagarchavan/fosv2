/**
 * The fidelity gate: the arithmetic, and the shape of a conformance verdict.
 *
 * `ConformOutcome` is the control plane's own type, deliberately not
 * `@fanos/conform`'s `ConformResult`. The toolchain adapter maps one to the
 * other. That indirection buys two things worth more than it costs: the gate is
 * testable without importing the compiler, and a change to the conformer's
 * result shape becomes a one-file adapter fix instead of a schema migration.
 *
 * Every function here is pure.
 */
export interface CoverageCounts {
  paints: number;
  direct: number;
  absorbed: number;
  repeated: number;
  missing: number;
}

export interface GeometryCounts {
  compared: number;
  skipped: number;
  /** Nodes whose content the frame does not own — icon library, API art. */
  exempt: number;
  worstDelta: number;
  /**
   * Sum of each failing node's worst axis delta, in px.
   *
   * Recorded because the error count does not move when the tree gets better:
   * a 262px collapse and a 2px rounding difference are one error each.
   */
  totalDelta: number;
}

export interface Finding {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  nodeId: string | null;
}

/** What the conformer said, in the control plane's vocabulary. */
export interface ConformOutcome {
  ok: boolean;
  errors: Finding[];
  warnings: Finding[];
  coverage: CoverageCounts;
  geometry: GeometryCounts;
  nodeCount: number;
  waived: number;
}

export interface Thresholds {
  /** Any error at all fails the gate, by default. */
  maxErrors: number;
  /** Warnings are advisory unless this is set. */
  maxWarnings: number | null;
  /** Fraction of painting IR nodes that must be accounted for. */
  minCoverage: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  maxErrors: 0,
  maxWarnings: null,
  minCoverage: 1,
};

export interface FindingSummary {
  code: string;
  severity: string;
  count: number;
  sample: string;
}

export interface FidelityReport {
  id: string;
  runId: string;
  surfaceVersionId: string;
  passed: boolean;
  score: number;
  thresholds: Thresholds;
  findings: FindingSummary[];
  reportArtifactId: string | null;
  createdAt: Date;
}

export interface FidelityView extends Omit<FidelityReport, "createdAt"> {
  createdAt: string;
}

/**
 * Coverage of painting IR nodes, 0..1.
 *
 * Deliberately one metric rather than a blend of several: a score nobody can
 * decompose is a score nobody trusts, and the first time it fails a build
 * somebody will switch the gate off rather than argue with a magic number.
 */
export function scoreOf(outcome: ConformOutcome): number {
  const { paints, direct, absorbed, repeated } = outcome.coverage;
  if (paints === 0) return 1;
  return clamp((direct + absorbed + repeated) / paints);
}

export function evaluate(outcome: ConformOutcome, thresholds: Thresholds): boolean {
  if (outcome.errors.length > thresholds.maxErrors) return false;
  if (thresholds.maxWarnings !== null && outcome.warnings.length > thresholds.maxWarnings) {
    return false;
  }
  return scoreOf(outcome) >= thresholds.minCoverage;
}

/** Rule-level rollup for the report row. The full detail lives in the artifact. */
export function summarise(outcome: ConformOutcome): FindingSummary[] {
  const buckets = new Map<string, FindingSummary>();

  const add = (finding: Finding, severity: string) => {
    const key = `${finding.code}:${severity}`;
    const hit = buckets.get(key);
    if (hit) hit.count += 1;
    else buckets.set(key, { code: finding.code, severity, count: 1, sample: finding.message });
  };

  for (const f of outcome.errors) add(f, "error");
  for (const f of outcome.warnings) add(f, "warning");

  return [...buckets.values()].sort((a, b) => b.count - a.count);
}

function clamp(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function toFidelityView(report: FidelityReport): FidelityView {
  return { ...report, createdAt: report.createdAt.toISOString() };
}
