/**
 * BullMQ adapter for `RunQueue`.
 *
 * The job carries a run id and nothing else. Postgres owns run state; Redis is
 * only the wake-up call. A flushed Redis is therefore a recoverable annoyance —
 * re-enqueue everything still `queued` — rather than lost work, and the two
 * stores can never disagree about what a run is.
 */
import { Queue, Worker, type ConnectionOptions, type Processor } from "bullmq";
import IORedis from "ioredis";

import type { RunQueue } from "../domain/ports.js";

export const PIPELINE_QUEUE = "fanos.pipeline";

export interface RunJob {
  runId: string;
  projectId: string;
}

export function createRedisConnection(url: string): IORedis {
  return new IORedis(url, {
    // BullMQ blocks on commands and requires this to be null, not a count.
    maxRetriesPerRequest: null,
  });
}

export interface BullQueueHandle extends RunQueue {
  raw: Queue<RunJob>;
  close: () => Promise<void>;
}

export function createBullRunQueue(connection: ConnectionOptions): BullQueueHandle {
  const queue = new Queue<RunJob>(PIPELINE_QUEUE, {
    connection,
    defaultJobOptions: {
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
      backoff: { type: "exponential", delay: 2_000 },
    },
  });

  return {
    raw: queue,
    async enqueue(job, opts) {
      // Job id = run id, so a double submit collapses to one job even if the
      // idempotency check upstream is bypassed.
      await queue.add("run", job, { jobId: job.runId, attempts: opts?.attempts ?? 3 });
    },
    close: () => queue.close(),
  };
}

export function createRunWorker(
  connection: ConnectionOptions,
  concurrency: number,
  processor: Processor<RunJob>,
): Worker<RunJob> {
  return new Worker<RunJob>(PIPELINE_QUEUE, processor, { connection, concurrency });
}
