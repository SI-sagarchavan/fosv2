/**
 * A scriptable `Toolchain`.
 *
 * Before the ports existed, exercising the run state machine meant running the
 * real compiler over a real Figma export — so the failure paths (a step that
 * throws, a permanent 4xx, a gate that fails) were tested by hand or not at
 * all. Here they are one line each.
 */
import { AppError } from "../../src/kernel/errors.js";
import type { ConformOutcome } from "../../src/modules/fidelity/domain/gate.js";
import type {
  CompileOutcome,
  GeometryMeasurer,
  ParsedIr,
  ParsedTheme,
  Toolchain,
} from "../../src/modules/runs/domain/ports.js";

export interface FakeToolchainScript {
  parseIr?: () => ParsedIr;
  parseTheme?: () => ParsedTheme;
  compile?: () => CompileOutcome;
  conform?: () => ConformOutcome;
}

export function passingConform(over: Partial<ConformOutcome> = {}): ConformOutcome {
  return {
    ok: true,
    errors: [],
    warnings: [],
    coverage: { paints: 10, direct: 10, absorbed: 0, repeated: 0, missing: 0 },
    geometry: { compared: 4, skipped: 0, exempt: 0, worstDelta: 0.2, totalDelta: 0 },
    nodeCount: 12,
    waived: 0,
    ...over,
  };
}

export function failingConform(): ConformOutcome {
  return passingConform({
    ok: false,
    errors: [{ code: "C1", severity: "error", message: "node not represented", nodeId: "n1" }],
    coverage: { paints: 10, direct: 7, absorbed: 0, repeated: 0, missing: 3 },
  });
}

export class FakeToolchain implements Toolchain {
  readonly calls: string[] = [];

  constructor(private readonly script: FakeToolchainScript = {}) {}

  parseIr(): ParsedIr {
    this.calls.push("parseIr");
    return this.script.parseIr?.() ?? { handle: { root: "ir" }, nodeCount: 42, rootNodeId: "1:1" };
  }

  parseTheme(): ParsedTheme {
    this.calls.push("parseTheme");
    return this.script.parseTheme?.() ?? { handle: { tokens: {} }, id: "theme-1" };
  }

  compile(): CompileOutcome {
    this.calls.push("compile");
    return (
      this.script.compile?.() ?? {
        tree: { schemaVersion: "1.0.0", nodes: [{ id: "root", type: "Box" }] },
        stats: { irNodes: 42, emitted: 30, absorbed: 12 },
        notes: [],
        requiredSurfaces: [],
        requiredAssets: [],
        metrics: { rawValues: 0, rawPositions: 0, tokenCoverage: 1 },
      }
    );
  }

  /** Recorded so a test can prove boxes actually reached the geometry check. */
  lastConform?: {
    boxes?: readonly { id: string }[];
    rootSrc?: string;
    tolerance?: number;
  };

  conform(input: {
    boxes?: readonly { id: string }[];
    rootSrc?: string;
    tolerance?: number;
  }): ConformOutcome {
    this.calls.push("conform");
    this.lastConform = input;
    return this.script.conform?.() ?? passingConform();
  }
}

/** Measures nothing, and says so — the shape of a host with no chromium. */
export function unavailableMeasurer(reason = "no chromium here"): GeometryMeasurer {
  return { measure: async () => ({ measured: false, reason }) };
}

/** Returns fixed boxes, so a test can assert they arrive at conform. */
export function fakeMeasurer(boxes = [{ id: "root", x: 0, y: 0, w: 100, h: 40 }]): GeometryMeasurer {
  return { measure: async () => ({ measured: true, boxes }) };
}

/** A toolchain whose compile step always fails, permanently or otherwise. */
export function brokenToolchain(mode: "permanent" | "transient"): Toolchain {
  return new FakeToolchain({
    compile: () => {
      throw mode === "permanent"
        ? AppError.unprocessable("figma IR artifact failed schema validation")
        : new Error("compiler segfaulted");
    },
  });
}
