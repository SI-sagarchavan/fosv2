/**
 * The HTTP process. Serves the control plane; executes nothing.
 *
 * Runs and workers are separate processes on purpose: a compile that pins a
 * core must not make a health check time out, and the two scale on different
 * axes.
 */
import { loadConfig } from "./config.js";
import { createContext } from "./context.js";
import { buildServer } from "./platform/http/server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const ctx = createContext(config);
  const app = buildServer(ctx);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await ctx.close();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port: config.PORT, host: config.HOST });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
