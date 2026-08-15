/**
 * The gate's ledger.
 *
 * Thresholds are copied onto every report at the moment it is written.
 * Tightening the gate next quarter must not retroactively turn a shipped pass
 * into a fail — the pass is a historical fact about a version that went live.
 */
import {
  DEFAULT_THRESHOLDS,
  evaluate,
  scoreOf,
  summarise,
  toFidelityView,
  type ConformOutcome,
  type FidelityView,
  type Thresholds,
} from "../domain/gate.js";
import type { FidelityRepository } from "../domain/ports.js";

export interface FidelityServiceDeps {
  repo: FidelityRepository;
  thresholds?: Thresholds;
}

export class FidelityService {
  private readonly thresholds: Thresholds;

  constructor(private readonly deps: FidelityServiceDeps) {
    this.thresholds = deps.thresholds ?? DEFAULT_THRESHOLDS;
  }

  async record(input: {
    runId: string;
    surfaceVersionId: string;
    outcome: ConformOutcome;
    reportArtifactId?: string;
    thresholds?: Thresholds;
  }): Promise<FidelityView> {
    const thresholds = input.thresholds ?? this.thresholds;

    const report = await this.deps.repo.record({
      runId: input.runId,
      surfaceVersionId: input.surfaceVersionId,
      passed: evaluate(input.outcome, thresholds),
      score: scoreOf(input.outcome),
      thresholds,
      findings: summarise(input.outcome),
      reportArtifactId: input.reportArtifactId ?? null,
    });

    return toFidelityView(report);
  }

  /** Satisfies the `GateLookup` port surfaces declares. */
  async latestForVersion(surfaceVersionId: string): Promise<FidelityView | null> {
    const report = await this.deps.repo.latestForVersion(surfaceVersionId);
    return report ? toFidelityView(report) : null;
  }

  async forRun(runId: string): Promise<FidelityView[]> {
    const reports = await this.deps.repo.listForRun(runId);
    return reports.map(toFidelityView);
  }
}
