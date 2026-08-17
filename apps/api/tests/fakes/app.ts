/**
 * Assembles the whole application over in-memory adapters.
 *
 * This is `createContext` with different adapters plugged in — the same
 * `assemble` function, the same services, the same wiring. If a test passes
 * here and fails in production, the difference is in an adapter, and that is
 * exactly where you want to be looking.
 */
import { loadConfig, type Config } from "../../src/config.js";
import { assemble, type AppContext } from "../../src/context.js";
import type { GeometryMeasurer, Toolchain } from "../../src/modules/runs/domain/ports.js";
import {
  FixedClock,
  MemoryArtifactRepo,
  MemoryBlobStore,
  MemoryExportRepo,
  MemoryFidelityRepo,
  MemoryFigmaFileDirectory,
  MemoryProjectRepo,
  MemoryRunOwnership,
  MemoryRunRepo,
  MemorySurfaceRepo,
  RecordingAudit,
  RecordingQueue,
  RecordingSyncGateway,
} from "./repos.js";
import { fakeMeasurer, FakeToolchain } from "./toolchain.js";

const TEST_CONFIG = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://unused:unused@localhost:5432/unused",
  REDIS_URL: "redis://localhost:6379",
} as const;

export interface TestApp {
  ctx: AppContext;
  config: Config;
  clock: FixedClock;
  audit: RecordingAudit;
  queue: RecordingQueue;
  syncGateway: RecordingSyncGateway;
  toolchain: Toolchain;
  repos: {
    projects: MemoryProjectRepo;
    artifacts: MemoryArtifactRepo;
    surfaces: MemorySurfaceRepo;
    runs: MemoryRunRepo;
    fidelity: MemoryFidelityRepo;
    exports: MemoryExportRepo;
  };
  figmaFiles: MemoryFigmaFileDirectory;
  blobs: MemoryBlobStore;
  /** Creates a project and returns its id — most tests start here. */
  seedProject(slug?: string): Promise<string>;
}

export function createTestApp(
  over: { toolchain?: Toolchain; measurer?: GeometryMeasurer } = {},
): TestApp {
  const config = loadConfig({ ...TEST_CONFIG });
  const clock = new FixedClock();
  const audit = new RecordingAudit();
  const queue = new RecordingQueue();
  const blobs = new MemoryBlobStore();
  const syncGateway = new RecordingSyncGateway();
  const toolchain = over.toolchain ?? new FakeToolchain();

  const repos = {
    projects: new MemoryProjectRepo(),
    artifacts: new MemoryArtifactRepo(),
    surfaces: new MemorySurfaceRepo(),
    runs: new MemoryRunRepo(),
    fidelity: new MemoryFidelityRepo(),
    exports: new MemoryExportRepo(),
  };
  const figmaFiles = new MemoryFigmaFileDirectory();

  const ctx = assemble({
    config,
    adapters: {
      ...repos,
      blobs,
      queue,
      toolchain,
      measurer: over.measurer ?? fakeMeasurer(),
      audit,
      clock,
      syncGateway,
      runOwnership: new MemoryRunOwnership(repos.runs),
      exports: repos.exports,
      figmaFiles,
    },
  });

  return {
    ctx,
    config,
    clock,
    audit,
    queue,
    syncGateway,
    toolchain,
    repos,
    figmaFiles,
    blobs,
    async seedProject(slug = "acme") {
      const project = await ctx.projects.create({ slug, name: "Acme" }, "tester");
      return project.id;
    },
  };
}
