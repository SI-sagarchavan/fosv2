/**
 * Postgres adapter for `AuditSink`.
 *
 * Swallows its own failures by design. The contract in `kernel/audit.ts` is
 * that recording must never fail the command that triggered it — a publish that
 * worked but went unlogged beats a publish rejected because the log was full.
 * Failures are logged loudly rather than silently, so the gap is visible.
 */
import { and, desc, eq, type SQL } from "drizzle-orm";

import type { AuditEntry, AuditRecord, AuditSink } from "../../../kernel/audit.js";
import type { Db } from "../../../platform/db/client.js";
import { auditLog } from "../../../platform/db/schema.js";

export interface AuditLogger {
  warn: (obj: unknown, msg: string) => void;
}

export class DrizzleAuditSink implements AuditSink {
  constructor(
    private readonly db: Db,
    private readonly logger: AuditLogger = { warn: () => {} },
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.db.insert(auditLog).values({
        projectId: entry.projectId,
        actor: entry.actor,
        action: entry.action,
        subjectType: entry.subjectType,
        subjectId: entry.subjectId,
        diff: entry.diff ?? {},
      });
    } catch (err) {
      this.logger.warn({ err, entry }, "audit write failed");
    }
  }

  async list(opts: {
    projectId?: string;
    subjectType?: string;
    subjectId?: string;
    limit: number;
  }): Promise<AuditRecord[]> {
    const filters: SQL[] = [];
    if (opts.projectId) filters.push(eq(auditLog.projectId, opts.projectId));
    if (opts.subjectType) filters.push(eq(auditLog.subjectType, opts.subjectType));
    if (opts.subjectId) filters.push(eq(auditLog.subjectId, opts.subjectId));

    const rows = await this.db
      .select()
      .from(auditLog)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(auditLog.at))
      .limit(opts.limit);

    return rows.map((row) => ({
      id: row.id,
      actor: row.actor,
      action: row.action,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      diff: row.diff as Record<string, unknown>,
      at: row.at.toISOString(),
    }));
  }
}
