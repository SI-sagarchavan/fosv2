import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli.js";

const FIXTURE = new URL("../fixtures/southern-brave.json", import.meta.url).pathname;
const SURFACES = new URL("../surfaces/southern-brave.json", import.meta.url).pathname;

let out: string[] = [];
let err: string[] = [];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "fos-tokens-cli-"));
}

function readDir(dir: string): Map<string, string> {
  return new Map(readdirSync(dir).sort().map((f) => [f, readFileSync(join(dir, f), "utf8")]));
}

describe("check", () => {
  it("exits non-zero on the real fixture and names both error classes", () => {
    const code = run(["check", "--theme", FIXTURE, "--surfaces", SURFACES]);
    expect(code).toBe(1);
    const report = out.join("");
    expect(report).toContain("E1");
    expect(report).toContain("E6");
    expect(report).toContain("h3_medium");
    expect(report).toContain("xl_medium");
    expect(report).toContain("xl_regular");
    expect(report).toContain("core_sec_500 == core_sec_600 == #2939a3");
    expect(report).toContain("FAIL — 4 errors in 2 classes");
  });

  it("emits machine-readable JSON under --json", () => {
    const code = run(["check", "--theme", FIXTURE, "--surfaces", SURFACES, "--json"]);
    expect(code).toBe(1);
    const parsed = JSON.parse(out.join(""));
    expect(parsed.ok).toBe(false);
    expect(parsed.counts).toMatchObject({ E1: 3, E6: 1, W1: 1, W2: 5, W3: 4, W4: 5, W5: 1, I1: 1 });
    expect(parsed.theme.slug).toBe("style-southern-brave");
    expect(parsed.findings[0]).toHaveProperty("code");
  });
});

describe("build", () => {
  it("refuses to emit while validation fails", () => {
    const dir = tmp();
    expect(run(["build", "--theme", FIXTURE, "--out", dir])).toBe(1);
    expect(err.join("")).toContain("build aborted");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("emits under --force", () => {
    const dir = tmp();
    expect(run(["build", "--theme", FIXTURE, "--surfaces", SURFACES, "--out", dir, "--force"])).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(["manifest.json", "tailwind.css", "tokens.css", "tokens.d.ts"]);
  });

  it("is byte-identical across two runs", () => {
    // The CSS is content-hashed for cache busting, so a byte that moves for no
    // reason invalidates every consumer's cache.
    const a = tmp();
    const b = tmp();
    const args = (dir: string) => ["build", "--theme", FIXTURE, "--surfaces", SURFACES, "--out", dir, "--force"];
    run(args(a));
    run(args(b));
    expect(readDir(a)).toEqual(readDir(b));
  });

  it("records a content hash per file in the manifest", () => {
    const dir = tmp();
    run(["build", "--theme", FIXTURE, "--surfaces", SURFACES, "--out", dir, "--force"]);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(Object.keys(manifest.files).sort()).toEqual(["tailwind.css", "tokens.css", "tokens.d.ts"]);
    expect(manifest.files["tokens.css"]).toMatch(/^[0-9a-f]{16}$/);
    expect(manifest.theme.slug).toBe("style-southern-brave");
    expect(manifest.breakpoints).toEqual({ md: 768, lg: 1280 });
  });

  it("honours --scope attr and custom breakpoints", () => {
    const dir = tmp();
    run([
      "build",
      "--theme", FIXTURE,
      "--out", dir,
      "--force",
      "--scope", "attr",
      "--md", "700",
      "--lg", "1200",
    ]);
    const css = readFileSync(join(dir, "tokens.css"), "utf8");
    expect(css).toContain('[data-fos-theme="style-southern-brave"] {');
    expect(css).toContain("@media (min-width: 700px) {");
    expect(css).toContain("--fos-bp-lg: 1200px;");
  });
});

describe("types", () => {
  it("writes the union module", () => {
    const dir = tmp();
    const file = join(dir, "tokens.d.ts");
    expect(run(["types", "--theme", FIXTURE, "--surfaces", SURFACES, "--out", file])).toBe(0);
    const contents = readFileSync(file, "utf8");
    expect(contents).toContain('"space.0_5"');
    expect(contents).toContain("export type SurfaceToken =");
    expect(contents).not.toContain('"type.xl_medium"');
  });
});

describe("tailwind", () => {
  it("writes a v4 @theme block by default", () => {
    const dir = tmp();
    const file = join(dir, "theme.css");
    expect(run(["tailwind", "--theme", FIXTURE, "--out", file])).toBe(0);
    expect(readFileSync(file, "utf8")).toContain("@theme {");
  });

  it("writes a v3 preset under --v3", () => {
    const dir = tmp();
    const file = join(dir, "preset.js");
    expect(run(["tailwind", "--theme", FIXTURE, "--out", file, "--v3"])).toBe(0);
    expect(readFileSync(file, "utf8")).toContain("module.exports = {");
  });
});

describe("argument handling", () => {
  it("prints usage with no command and exits non-zero", () => {
    expect(run([])).toBe(1);
    expect(out.join("")).toContain("fos-tokens");
  });

  it("rejects an unknown command", () => {
    expect(run(["frobnicate"])).toBe(1);
    expect(err.join("")).toContain('unknown command "frobnicate"');
  });

  it("accepts --flag=value as well as --flag value", () => {
    expect(run(["check", `--theme=${FIXTURE}`, "--json"])).toBe(1);
    expect(JSON.parse(out.join("")).theme.name).toBe("Style Southern Brave");
  });
});
