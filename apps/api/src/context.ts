/**
 * The composition root — the only file that knows both halves of the hexagon.
 *
 * Every adapter is chosen here and nowhere else. Read top to bottom it is a
 * complete inventory of what this application depends on: Postgres, Redis, a
 * filesystem, the FanOS toolchain, a clock. Nothing else in `src/` imports any
 * of them outside its own `adapters/` folder, and `tests/architecture.test.ts`
 * enforces that.
 *
 * `buildContext` takes ports rather than URLs so tests can assemble the same
 * application over in-memory fakes.
 */
import { sql } from "drizzle-orm";

import type { Config } from "./config.js";
import type { AuditSink } from "./kernel/audit.js";
import type { Clock } from "./kernel/clock.js";
import { DrizzleArtifactRepository } from "./modules/artifacts/adapters/drizzle-artifact-repo.js";
import { createFsBlobStore } from "./modules/artifacts/adapters/fs-blob-store.js";
import { ArtifactService } from "./modules/artifacts/app/artifact-service.js";
import type { ArtifactRepository, BlobStore } from "./modules/artifacts/domain/ports.js";
import { DrizzleAuditSink } from "./modules/audit/adapters/drizzle-audit-sink.js";
import {
  DrizzleExportRepository,
  DrizzleFigmaFileDirectory,
} from "./modules/exports/adapters/drizzle-export-repo.js";
import { ExportService } from "./modules/exports/app/export-service.js";
import type { ExportRepository, FigmaFileDirectory } from "./modules/exports/domain/ports.js";
import { DrizzleFidelityRepository } from "./modules/fidelity/adapters/drizzle-fidelity-repo.js";
import { FidelityService } from "./modules/fidelity/app/fidelity-service.js";
import type { FidelityRepository } from "./modules/fidelity/domain/ports.js";
import { DrizzleProjectRepository } from "./modules/projects/adapters/drizzle-project-repo.js";
import { ProjectService } from "./modules/projects/app/project-service.js";
import type { ProjectRepository } from "./modules/projects/domain/ports.js";
import {
  createBullRunQueue,
  createRedisConnection,
  type BullQueueHandle,
} from "./modules/runs/adapters/bullmq-queue.js";
import { DrizzleRunRepository } from "./modules/runs/adapters/drizzle-run-repo.js";
import { createFanosToolchain } from "./modules/runs/adapters/fanos-toolchain.js";
import { RunService } from "./modules/runs/app/run-service.js";
import type { RunQueue, RunRepository, Toolchain } from "./modules/runs/domain/ports.js";
import { createElectricGateway } from "./modules/sync/adapters/electric-gateway.js";
import { DrizzleRunOwnership } from "./modules/sync/adapters/drizzle-run-ownership.js";
import { SyncService } from "./modules/sync/app/sync-service.js";
import type { RunOwnership, SyncGateway } from "./modules/sync/domain/ports.js";
import { DrizzleSurfaceRepository } from "./modules/surfaces/adapters/drizzle-surface-repo.js";
import { SurfaceService } from "./modules/surfaces/app/surface-service.js";
import type { SurfaceRepository } from "./modules/surfaces/domain/ports.js";
import { systemClock } from "./platform/clock.js";
import { createDb, type Db, type DbHandle } from "./platform/db/client.js";

export interface Logger {
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
  error: (obj: unknown, msg: string) => void;
}

const CONSOLE_LOGGER: Logger = {
  info: (o, m) => console.log(m, o),
  warn: (o, m) => console.warn(m, o),
  error: (o, m) => console.error(m, o),
};

/** Every port the application needs, already chosen. */
export interface Adapters {
  projects: ProjectRepository;
  artifacts: ArtifactRepository;
  surfaces: SurfaceRepository;
  runs: RunRepository;
  fidelity: FidelityRepository;
  blobs: BlobStore;
  queue: RunQueue;
  toolchain: Toolchain;
  audit: AuditSink & { list: DrizzleAuditSink["list"] };
  clock: Clock;
  syncGateway: SyncGateway;
  runOwnership: RunOwnership;
  exports: ExportRepository;
  figmaFiles: FigmaFileDirectory & { claim: DrizzleFigmaFileDirectory["claim"] };
}

export interface AppContext {
  config: Config;
  logger: Logger;
  projects: ProjectService;
  artifacts: ArtifactService;
  surfaces: SurfaceService;
  fidelity: FidelityService;
  runs: RunService;
  sync: SyncService;
  exports: ExportService;
  figmaFiles: Adapters["figmaFiles"];
  audit: Adapters["audit"];
  /** For the readiness probe only; no service reaches through this. */
  health: { ping: () => Promise<void> };
  close: () => Promise<void>;
}

/**
 * Wire services over whatever adapters were handed in.
 *
 * The order below is forced by the dependency graph and reads as one: audit is
 * needed by everything, artifacts by surfaces and runs, surfaces by runs.
 */
export function assemble(parts: {
  config: Config;
  adapters: Adapters;
  logger?: Logger;
  health?: { ping: () => Promise<void> };
  close?: () => Promise<void>;
}): AppContext {
  const { config, adapters } = parts;
  const logger = parts.logger ?? CONSOLE_LOGGER;

  const projects = new ProjectService({ repo: adapters.projects, audit: adapters.audit });

  const artifacts = new ArtifactService({
    repo: adapters.artifacts,
    blobs: adapters.blobs,
    audit: adapters.audit,
  });

  const fidelity = new FidelityService({ repo: adapters.fidelity });

  const surfaces = new SurfaceService({
    repo: adapters.surfaces,
    // ArtifactService and FidelityService satisfy the lookup ports structurally;
    // surfaces never learns their concrete types.
    artifacts,
    gate: fidelity,
    audit: adapters.audit,
    clock: adapters.clock,
  });

  const runs = new RunService({
    repo: adapters.runs,
    queue: adapters.queue,
    artifacts,
    surfaces,
    toolchain: adapters.toolchain,
    gate: fidelity,
    audit: adapters.audit,
    clock: adapters.clock,
    maxAttempts: config.RUN_MAX_ATTEMPTS,
    logger,
  });

  const exportsService = new ExportService({
    repo: adapters.exports,
    files: adapters.figmaFiles,
    artifacts,
    audit: adapters.audit,
  });

  const sync = new SyncService({
    gateway: adapters.syncGateway,
    runs: adapters.runOwnership,
  });

  return {
    config,
    logger,
    projects,
    artifacts,
    surfaces,
    fidelity,
    runs,
    sync,
    exports: exportsService,
    figmaFiles: adapters.figmaFiles,
    audit: adapters.audit,
    health: parts.health ?? { ping: async () => {} },
    close: parts.close ?? (async () => {}),
  };
}

/** The production wiring: real Postgres, real Redis, real filesystem, real compiler. */
export function createContext(config: Config, logger: Logger = CONSOLE_LOGGER): AppContext {
  const dbHandle: DbHandle = createDb(config);
  const connection = createRedisConnection(config.REDIS_URL);
  const queue: BullQueueHandle = createBullRunQueue(connection);

  return assemble({
    config,
    logger,
    adapters: buildDrizzleAdapters(dbHandle.db, queue, config, logger),
    health: {
      async ping() {
        // Both dependencies, actually touched. A probe that only proves the
        // process is alive tells you nothing worth knowing.
        await dbHandle.db.execute(sql`select 1`);
        await queue.raw.getJobCounts();
      },
    },
    async close() {
      await queue.close();
      await connection.quit();
      await dbHandle.close();
    },
  });
}

export function buildDrizzleAdapters(
  db: Db,
  queue: RunQueue,
  config: Pick<Config, "BLOB_ROOT" | "ELECTRIC_URL">,
  logger: Logger,
): Adapters {
  return {
    projects: new DrizzleProjectRepository(db),
    artifacts: new DrizzleArtifactRepository(db),
    surfaces: new DrizzleSurfaceRepository(db),
    runs: new DrizzleRunRepository(db),
    fidelity: new DrizzleFidelityRepository(db),
    blobs: createFsBlobStore(config.BLOB_ROOT),
    queue,
    toolchain: createFanosToolchain(),
    audit: new DrizzleAuditSink(db, logger),
    clock: systemClock,
    syncGateway: createElectricGateway(config.ELECTRIC_URL),
    runOwnership: new DrizzleRunOwnership(db),
    exports: new DrizzleExportRepository(db),
    figmaFiles: new DrizzleFigmaFileDirectory(db),
  };
}
