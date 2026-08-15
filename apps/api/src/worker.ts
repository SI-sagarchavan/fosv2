/**
 * The worker process: the second driving adapter.
 *
 * It drives exactly the same `RunService` the HTTP process does. That is the
 * payoff of keeping decisions out of the transport layer — this file is thirty
 * lines of BullMQ wiring and no business logic at all.
 */
import { loadConfig } from "./config.js";
import { createContext } from "./context.js";
import { createRedisConnection, createRunWorker } from "./modules/runs/adapters/bullmq-queue.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const ctx = createContext(config);
  const connection = createRedisConnection(config.REDIS_URL);

  const worker = createRunWorker(connection, config.WORKER_CONCURRENCY, async (job) => {
    await ctx.runs.execute(job.data.runId);
  });

  worker.on("failed", (job, err) => {
    ctx.logger.error({ runId: job?.data.runId, err }, "job failed");
  });

  worker.on("completed", (job) => {
    ctx.logger.info({ runId: job.data.runId }, "job completed");
  });

  const shutdown = async (signal: string): Promise<void> => {
    ctx.logger.info({ signal }, "worker shutting down");
    // Lets in-flight jobs finish; BullMQ re-delivers anything still running
    // after the grace period.
    await worker.close();
    await connection.quit();
    await ctx.close();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  ctx.logger.info({ concurrency: config.WORKER_CONCURRENCY }, "worker ready");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
