/**
 * Findings -> batches. PURE — no Figma import.
 *
 * A batch is the product. One row, one payoff, one button — 110 layers of white
 * fixed in a click, not 110 rows of advice. Everything about the shape of this
 * module is in service of that: the ranking is by occurrence count so the
 * biggest lever is first, and the payoff is in the same units as the score.
 *
 * The grouping key is (rule, slot, value, proposed token). The spec for this
 * package named the first, third and fourth; the slot is here because without it
 * a 16px gap and a 16px left padding collapse into one row labelled "16", and
 * the whole point of the row is that a designer can tell what it is about.
 */
import { percent } from "./coverage.js";
import type { Batch, BatchItem, Finding, FindingScope, Proposal, Rule } from "./types.js";
import { isFixProposal } from "./types.js";

export interface BatchInput {
  finding: Finding;
  proposal: Proposal | null;
  rule: Pick<Rule, "id" | "code">;
}

export function buildBatches(inputs: readonly BatchInput[], totalSlots: number): Batch[] {
  const groups = new Map<string, BatchInput[]>();
  for (const input of inputs) {
    if (!input.finding.occupiesSlot) continue;
    const key = batchKey(input);
    const bucket = groups.get(key);
    if (bucket) bucket.push(input);
    else groups.set(key, [input]);
  }

  const batches: Batch[] = [];
  for (const [id, bucket] of groups) {
    const first = bucket[0]!;
    const proposal = first.proposal;
    const items: BatchItem[] = bucket.map((input) => ({
      nodeId: input.finding.nodeId,
      propPath: input.finding.propPath,
    }));
    const distinctRawValues = new Set(
      bucket.map((input) => input.finding.rawValue ?? input.finding.currentValue),
    ).size;

    batches.push({
      id,
      ruleId: first.rule.id,
      ruleCode: first.rule.code,
      scope: first.finding.scope,
      currentValue: first.finding.currentValue,
      label: `${slotLabel(first.finding.scope)} ${first.finding.currentValue}`,
      slotLabel: slotLabel(first.finding.scope),
      count: bucket.length,
      distinctRawValues,
      proposal,
      coverageGain: percent(bucket.length, totalSlots),
      safe: isSafe(proposal),
      message: first.finding.message,
      items,
    });
  }

  // Count first — that is the ranking a designer wants, biggest lever at the
  // top. The rest of the comparator only exists so the order is reproducible.
  batches.sort(
    (a, b) =>
      b.count - a.count ||
      b.coverageGain - a.coverageGain ||
      a.label.localeCompare(b.label) ||
      a.id.localeCompare(b.id),
  );
  return batches;
}

/**
 * Safe means: applying it to every layer in the batch, unattended, cannot
 * produce a wrong result. Exact value match, and a Figma variable actually
 * behind the token. Near matches are never safe by construction — a ΔE of 4 is
 * a question for a designer, not a licence to repaint 36 layers.
 */
export function isSafe(proposal: Proposal | null): boolean {
  if (!proposal || !isFixProposal(proposal)) return false;
  return proposal.kind === "exact" && proposal.bindable;
}

function batchKey(input: BatchInput): string {
  const ref = input.proposal && isFixProposal(input.proposal) ? input.proposal.tokenRef : "-";
  return `${input.rule.id}|${input.finding.scope}|${input.finding.currentValue}|${ref}`;
}

export type QueueGroup = "bind" | "review" | "create" | "stuck";

/** Which queue section a batch belongs in. The panel groups on this. */
export function queueGroup(batch: Batch): QueueGroup {
  const proposal = batch.proposal;
  if (!proposal) return "stuck";
  if (proposal.kind === "near") {
    return isFixProposal(proposal) && proposal.candidates.some((c) => c.bindable)
      ? "review"
      : "create";
  }
  if (proposal.kind === "exact") return proposal.bindable ? "bind" : "create";
  return "stuck";
}

export function groupQueue(batches: readonly Batch[]): Record<QueueGroup, Batch[]> {
  const out: Record<QueueGroup, Batch[]> = {
    bind: [],
    review: [],
    create: [],
    stuck: [],
  };
  for (const batch of batches) out[queueGroup(batch)].push(batch);
  return out;
}

export function slotLabel(scope: FindingScope): string {
  switch (scope) {
    case "gap":
      return "gap";
    case "padding":
      return "padding";
    case "radius":
      return "radius";
    case "fill":
      return "fill";
    case "stroke":
      return "stroke";
    case "text":
      return "text";
    case "effect":
      return "effect";
    case "page":
      return "page";
  }
}

/** Batches that can be applied in bulk, largest first. */
export function safeBatches(batches: readonly Batch[]): Batch[] {
  return batches.filter((batch) => batch.safe);
}

export function safeSlotCount(batches: readonly Batch[]): number {
  return safeBatches(batches).reduce((sum, batch) => sum + batch.count, 0);
}

/** How much of the loose total the top `n` batches account for. */
export function batchCoverage(batches: readonly Batch[], n: number, looseTotal: number): number {
  const covered = batches.slice(0, n).reduce((sum, batch) => sum + batch.count, 0);
  return percent(covered, looseTotal);
}

/** The smallest number of batches that accounts for `target`% of loose values. */
export function batchesToReach(
  batches: readonly Batch[],
  looseTotal: number,
  target = 90,
): number {
  let covered = 0;
  for (let i = 0; i < batches.length; i++) {
    covered += batches[i]!.count;
    if (percent(covered, looseTotal) >= target) return i + 1;
  }
  return batches.length;
}

