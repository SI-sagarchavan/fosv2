import type { FidelityReport, FindingSummary, Thresholds } from "./gate.js";

export interface NewFidelityReport {
  runId: string;
  surfaceVersionId: string;
  passed: boolean;
  score: number;
  thresholds: Thresholds;
  findings: FindingSummary[];
  reportArtifactId: string | null;
}

export interface FidelityRepository {
  /**
   * One report per (run, version). A retried run overwrites its own verdict
   * rather than stacking a second one, so "the gate result for this attempt"
   * stays a single answer.
   */
  record(input: NewFidelityReport): Promise<FidelityReport>;
  latestForVersion(surfaceVersionId: string): Promise<FidelityReport | null>;
  listForRun(runId: string): Promise<FidelityReport[]>;
}
