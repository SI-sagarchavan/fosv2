import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { emitTypes, tokenUnions } from "../src/emit/types.js";
import { loadSurfaces, loadTheme } from "../src/load.js";

const FIXTURE = new URL("../fixtures/southern-brave.json", import.meta.url).pathname;
const SURFACES = new URL("../surfaces/southern-brave.json", import.meta.url).pathname;

function theme() {
  return loadTheme(FIXTURE);
}

function unions(allowPartialTypography = false) {
  return new Map(
    tokenUnions(theme(), { surfaces: loadSurfaces(SURFACES), allowPartialTypography }).map((u) => [u.name, u.refs]),
  );
}

describe("union sizes", () => {
  it("matches the export", () => {
    const u = unions();
    expect(u.get("SpaceToken")).toHaveLength(21);
    expect(u.get("RadiusToken")).toHaveLength(8);
    expect(u.get("ColorToken")).toHaveLength(163);
    expect(u.get("OpacityToken")).toHaveLength(11);
    expect(u.get("GradientToken")).toHaveLength(22);
    expect(u.get("ShadowToken")).toHaveLength(5);
    expect(u.get("SurfaceToken")).toHaveLength(loadSurfaces(SURFACES).surfaces.size);
  });

  it("TypeToken is the 30-key intersection and excludes the partial styles", () => {
    // A partial style resolves at some viewports and vanishes at others. Putting
    // it in the union would tell every downstream consumer it is safe to emit.
    const refs = unions().get("TypeToken")!;
    expect(refs).toHaveLength(30);
    expect(refs).not.toContain("type.xl_medium");
    expect(refs).not.toContain("type.xl_regular");
    expect(refs).not.toContain("type.h3_medium");
    expect(refs).toContain("type.h1_bold");
  });

  it("grows to 33 under allowPartialTypography", () => {
    expect(unions(true).get("TypeToken")).toHaveLength(33);
  });
});

describe("ref formatting", () => {
  it("keeps the half-step spacing ref intact", () => {
    expect(unions().get("SpaceToken")).toContain("space.0_5");
  });

  it("sorts deterministically, numerics first", () => {
    const space = unions().get("SpaceToken")!;
    expect(space.slice(0, 5)).toEqual(["space.0", "space.0_5", "space.1", "space.1_5", "space.2"]);
    expect(unions().get("RadiusToken")![0]).toBe("radius.2xl");
  });

  it("prefixes surfaces with `surface.`", () => {
    expect(unions().get("SurfaceToken")).toContain("surface.card_player");
  });
});

describe("emitted module", () => {
  it("declares every union plus AnyToken", () => {
    const out = emitTypes(theme(), { surfaces: loadSurfaces(SURFACES) });
    for (const name of [
      "SpaceToken",
      "RadiusToken",
      "ColorToken",
      "OpacityToken",
      "GradientToken",
      "ShadowToken",
      "TypeToken",
      "SurfaceToken",
      "AnyToken",
    ]) {
      expect(out).toContain(`export type ${name} =`);
    }
  });

  it("is byte-identical across two runs", () => {
    const surfaces = loadSurfaces(SURFACES);
    expect(emitTypes(theme(), { surfaces })).toBe(emitTypes(theme(), { surfaces }));
  });

  it("compiles as a .d.ts under strict mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "fos-tokens-types-"));
    const file = join(dir, "tokens.d.ts");
    writeFileSync(file, emitTypes(theme(), { surfaces: loadSurfaces(SURFACES) }), "utf8");

    const program = ts.createProgram([file], {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      module: ts.ModuleKind.ESNext,
    });
    const diagnostics = ts.getPreEmitDiagnostics(program).filter((d) => d.file?.fileName === file);
    const messages = diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
    expect(messages).toEqual([]);
  });

  it("emits `never` for a category with no tokens rather than a broken union", () => {
    const out = emitTypes(theme()); // no surfaces supplied
    expect(out).toContain("export type SurfaceToken = never;");
    expect(out).not.toContain("| SurfaceToken");
  });
});
