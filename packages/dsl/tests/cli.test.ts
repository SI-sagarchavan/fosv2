import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRegistry, loadSurfaces, loadTheme } from "@fanos/tokens";
import { main, run } from "../src/cli.js";
import { flatTreeSchema } from "../src/flat.js";
import { validate } from "../src/validate.js";

const TREE = new URL("../fixtures/player-card.json", import.meta.url).pathname;
const THEME = new URL("../../tokens/fixtures/southern-brave.json", import.meta.url).pathname;
const SURFACES = new URL("../../tokens/surfaces/southern-brave.json", import.meta.url).pathname;

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

afterEach(() => vi.restoreAllMocks());

const tmp = () => mkdtempSync(join(tmpdir(), "fos-dsl-cli-"));

describe("check", () => {
  it("passes the card fixture and reports metrics", () => {
    const code = run(["check", "--tree", TREE, "--theme", THEME, "--surfaces", SURFACES]);
    expect(code).toBe(0);
    const report = out.join("");
    expect(report).toContain("PASS — 0 errors");
    // Assert the SHAPE of the line, not the fixture's current numbers — this
    // test owns the report format, not the card's raw-value debt.
    expect(report).toMatch(
      /rawValueCount \d+ \(space:\d+ color:\d+ size:\d+ duration:\d+ other:\d+; positions: \d+\)/,
    );
    expect(report).toMatch(/nodes \d+/);
  });

  it("emits machine-readable JSON", () => {
    run(["check", "--tree", TREE, "--theme", THEME, "--surfaces", SURFACES, "--json"]);
    const parsed = JSON.parse(out.join(""));
    expect(parsed.ok).toBe(true);
    // The CLI's job is to pass validate()'s metrics through untouched, so the
    // check is against validate() itself rather than a copy of its output.
    const tree = flatTreeSchema.parse(JSON.parse(readFileSync(TREE, "utf8")));
    const expected = validate(tree, {
      registry: createRegistry(loadTheme(THEME), { surfaces: loadSurfaces(SURFACES) }),
    }).metrics;
    expect(parsed.metrics).toEqual(expected);
    expect(parsed.metrics.nodeCount).toBe(tree.nodes.length);
  });

  it("fails without the surfaces file, because surface.* and asset.* stop resolving", () => {
    const code = run(["check", "--tree", TREE, "--theme", THEME]);
    expect(code).toBe(1);
    expect(out.join("")).toContain("T1");
  });
});

describe("types / schema / docs", () => {
  it("writes the .d.ts", () => {
    const file = join(tmp(), "nodes.d.ts");
    expect(run(["types", "--out", file])).toBe(0);
    expect(readFileSync(file, "utf8")).toContain("export type DslNode =");
  });

  it("writes the agent schema and reports its size", () => {
    const file = join(tmp(), "schema.json");
    expect(run(["schema", "--theme", THEME, "--surfaces", SURFACES, "--out", file])).toBe(0);
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(parsed.$schema).toContain("2020-12");
    expect(out.join("")).toMatch(/\d+B/);
  });

  it("honours --subset", () => {
    const full = join(tmp(), "full.json");
    const small = join(tmp(), "small.json");
    run(["schema", "--theme", THEME, "--surfaces", SURFACES, "--out", full]);
    run(["schema", "--theme", THEME, "--surfaces", SURFACES, "--out", small, "--subset", "Box,Stack,Text"]);
    expect(readFileSync(small, "utf8").length).toBeLessThan(readFileSync(full, "utf8").length);
  });

  it("writes the docs", () => {
    const file = join(tmp(), "docs.md");
    expect(run(["docs", "--out", file])).toBe(0);
    expect(readFileSync(file, "utf8")).toContain("# FanOS SDUI vocabulary");
  });
});

describe("argument handling", () => {
  it("prints usage with no command", () => {
    expect(run([])).toBe(1);
    expect(out.join("")).toContain("fos-dsl");
  });

  it("rejects an unknown command", () => {
    expect(run(["frobnicate"])).toBe(1);
    expect(err.join("")).toContain('unknown command "frobnicate"');
  });
});

describe("collapse", () => {
  const GRID = new URL("../fixtures/news-grid.json", import.meta.url).pathname;
  const BINDING = new URL("../fixtures/bindings/news-grid.binding.json", import.meta.url).pathname;

  /**
   * The default is a report, and the report says so. A command that quietly
   * rewrote a tree because it found something that looked repeated would be the
   * automatic collapse this whole feature exists not to do.
   */
  it("reports without changing anything", () => {
    const before = readFileSync(GRID, "utf8");
    expect(run(["collapse", "--tree", GRID])).toBe(0);
    const report = out.join("");
    expect(report).toContain("1 collapse proposal(s)");
    expect(report).toContain("[0] 3x under trailing_column");
    expect(report).toContain("saves 20 nodes");
    expect(report).toContain("Nothing was changed.");
    expect(readFileSync(GRID, "utf8")).toBe(before);
  });

  it("says out loud when a run carries identical copy", () => {
    run(["collapse", "--tree", GRID]);
    expect(out.join("")).toContain("varying content: none");
  });

  it("reports as JSON", () => {
    run(["collapse", "--tree", GRID, "--json"]);
    const parsed = JSON.parse(out.join(""));
    expect(parsed.nodes).toBe(69);
    expect(parsed.proposals).toHaveLength(1);
    expect(parsed.proposals[0].templateId).toBe("stack_12");
    expect(parsed.proposals[0]).not.toHaveProperty("confidence");
  });

  it("applies one proposal against a binding file", () => {
    const file = join(tmp(), "collapsed.json");
    expect(run(["collapse", "--tree", GRID, "--apply", "0", "--binding", BINDING, "--out", file])).toBe(0);
    expect(out.join("")).toContain("69 -> 50 nodes");

    const tree = flatTreeSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    const result = validate(tree, {
      registry: createRegistry(loadTheme(THEME), { surfaces: loadSurfaces(SURFACES) }),
    });
    expect(result.errors).toEqual([]);
    expect(tree.nodes.find((n) => n.type === "Repeater")?.props.over).toBe("news.items");
  });

  it("refuses to apply without a binding — a collapse with no data source draws one card", () => {
    const file = join(tmp(), "collapsed.json");
    // Through `main`, which is what the binary calls — `run` throws and `main`
    // is the layer that turns that into an exit code and a message.
    expect(main(["collapse", "--tree", GRID, "--apply", "0", "--out", file])).toBe(1);
    expect(err.join("")).toContain("missing --binding");
  });

  it("refuses an index that is not on the list", () => {
    expect(run(["collapse", "--tree", GRID, "--apply", "7", "--binding", BINDING, "--out", "/dev/null"])).toBe(1);
    expect(err.join("")).toContain("no such proposal");
  });
});
