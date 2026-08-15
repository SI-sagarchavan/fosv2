/**
 * The audit port.
 *
 * Every module writes to it, no module owns it, so it lives in the kernel. The
 * contract that matters is not in the types: **recording must never fail the
 * command that triggered it**. An unrecorded audit line is worth less than a
 * rejected publish, so implementations swallow their own errors.
 */
export interface AuditEntry {
  projectId: string | null;
  actor: string;
  /** Verb-shaped, past tense: "surface.published", "run.cancelled". */
  action: string;
  subjectType: string;
  subjectId: string;
  /** Only the fields that moved, never whole rows. */
  diff?: Record<string, unknown>;
}

export interface AuditSink {
  record(entry: AuditEntry): Promise<void>;
}

export interface AuditRecord extends Required<Omit<AuditEntry, "projectId">> {
  id: string;
  at: string;
}
