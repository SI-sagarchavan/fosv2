/**
 * Rules, one value at a time. No Figma, no fixture file — small trees, exact
 * expectations.
 */
import { describe, expect, it } from "vitest";
import { isFixProposal, type Finding, type Proposal, type Rule } from "../src/health/types.js";
import { RULES, lint, ruleById } from "../src/rules/index.js";
import { unboundFill } from "../src/rules/f1-unbound-fill.js";
import { unboundStroke } from "../src/rules/f2-unbound-stroke.js";
import { unboundTextStyle } from "../src/rules/f3-unbound-text-style.js";
import { unboundSpacing } from "../src/rules/f4-unbound-spacing.js";
import { unboundRadius } from "../src/rules/f5-unbound-radius.js";
import { unboundEffect } from "../src/rules/f6-unbound-effect.js";
import { defaultLayerNames, DEFAULT_NAME_RE } from "../src/rules/w1-default-layer-names.js";
import {
  bound,
  boundFill,
  context,
  document,
  gradient,
  loose,
  looseEffect,
  looseFill,
  looseStroke,
  looseText,
  node,
  themeSnapshot,
  withDepths,
} from "./health-fixtures.js";

const ctx = context();

function runRule(rule: Rule, root: Parameters<typeof document>[0]): Finding[] {
  return rule.check(document(withDepths(root)), ctx);
}

function proposalFor(rule: Rule, root: Parameters<typeof document>[0]): Proposal | null {
  const findings = runRule(rule, root);
  expect(findings.length).toBeGreaterThan(0);
  return rule.propose ? (rule.propose(findings[0]!, ctx) ?? null) : null;
}

describe("the registry", () => {
  it("declares what every rule protects", () => {
    for (const rule of RULES) {
      expect(rule.protects.length).toBeGreaterThan(10);
      expect(rule.id).toMatch(/^[a-z0-9-]+$/);
      expect(rule.code).toMatch(/^[BFW]\d$/);
    }
  });

  it("has unique ids and codes", () => {
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
    expect(new Set(RULES.map((r) => r.code)).size).toBe(RULES.length);
    expect(ruleById("unbound-fill")).toBe(unboundFill);
  });
});

describe("B1 root-not-autolayout", () => {
  const b1 = ruleById("root-not-autolayout")!;

  it("fires on a root that isn't a vertical auto-layout frame", () => {
    expect(runRule(b1, node({ layoutMode: "none" }))).toHaveLength(1);
    expect(runRule(b1, node({ layoutMode: "horizontal" }))).toHaveLength(1);
  });

  it("stays quiet on a vertical root", () => {
    expect(runRule(b1, node({ layoutMode: "vertical" }))).toHaveLength(0);
  });

  it("never offers a layout rewrite — that reflows the frame", () => {
    expect(b1.propose).toBeUndefined();
  });

  it("stays quiet on an overlay — most children are absolutely placed", () => {
    const root = node({
      layoutMode: "none",
      children: [
        node({ positioning: "absolute" }),
        node({ positioning: "absolute" }),
        node({ positioning: "auto" }),
      ],
    });
    expect(runRule(b1, root)).toHaveLength(0);
  });
});

describe("B2 groups-instead-of-frames", () => {
  const b2 = ruleById("groups-instead-of-frames")!;

  it("counts groups and the layers inside them", () => {
    const root = node({
      layoutMode: "vertical",
      children: [
        node({ type: "GROUP", children: [node(), node()] }),
        node({ type: "GROUP", children: [node()] }),
      ],
    });
    const finding = runRule(b2, root)[0]!;
    expect(finding.detail).toMatchObject({ groups: 2, layers: 3 });
  });

  it("counts a layer inside nested groups once", () => {
    // The naive sum would say 3 here. A designer counting their own layers
    // would say 2, and they would be right.
    const inner = node({ type: "GROUP", children: [node()] });
    const root = node({ children: [node({ type: "GROUP", children: [inner] })] });
    expect(runRule(b2, root)[0]!.detail).toMatchObject({ groups: 2, layers: 2 });
  });

  it("stays quiet with no groups", () => {
    expect(runRule(b2, node({ children: [node(), node()] }))).toHaveLength(0);
  });

  it("offers to convert the groups it counted", () => {
    const a = node({ type: "GROUP", id: "g1", children: [node()] });
    const root = node({ children: [a] });
    expect(proposalFor(b2, root)).toMatchObject({
      kind: "structural",
      action: "convert-groups",
    });
  });
});

describe("B3 no-mobile-frames", () => {
  const b3 = ruleById("no-mobile-frames")!;

  it("fires when nothing at the top level is mobile-width", () => {
    const root = node({ width: 1366, children: [node({ width: 1368 })] });
    const finding = runRule(b3, root)[0]!;
    expect(finding.detail?.widthsPresent).toBe("1366, 1368");
  });

  it("stays quiet when a top-level frame is in range", () => {
    const root = node({ width: 1366, children: [node({ width: 390 })] });
    expect(runRule(b3, root)).toHaveLength(0);
  });

  it("ignores a mobile-width frame buried inside the design", () => {
    // A 390px frame six levels deep is a component preview, not a mobile page.
    const deep = node({ children: [node({ children: [node({ width: 390 })] })] });
    const root = node({ width: 1366, children: [deep] });
    expect(runRule(b3, root)).toHaveLength(1);
  });
});

describe("F1 unbound-fill", () => {
  it("proposes an exact colour token and names the consequence", () => {
    const root = node({ fill: looseFill("#ffffff") });
    const findings = runRule(unboundFill, root);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("theme swap");
    expect(findings[0]!.occupiesSlot).toBe(true);

    const proposal = proposalFor(unboundFill, root)!;
    expect(proposal).toMatchObject({
      kind: "exact",
      tokenRef: "color.core_neu_00",
      bindable: true,
      confidence: 1,
    });
  });

  it("skips a bound fill", () => {
    expect(runRule(unboundFill, node({ fill: boundFill() }))).toHaveLength(0);
  });

  it("collapses gradients to one batching key and proposes nothing", () => {
    const raw = gradient("#ff4b32ff", "#2939a3ff");
    const finding = runRule(unboundFill, node({ fill: looseFill(raw) }))[0]!;
    expect(finding.currentValue).toBe("linear-gradient");
    expect(finding.rawValue).toBe(raw);

    const proposal = proposalFor(unboundFill, node({ fill: looseFill(raw) }))!;
    expect(proposal.kind).toBe("none");
    expect(isFixProposal(proposal)).toBe(false);
  });

  it("treats an image fill as content, not a missing token", () => {
    const proposal = proposalFor(unboundFill, node({ fill: looseFill("IMAGE:FILL") }))!;
    expect(proposal).toMatchObject({ kind: "none" });
    expect((proposal as { reason: string }).reason).toContain("content");
  });

  it("says so when the layer has more than one fill", () => {
    const finding = runRule(unboundFill, node({ fill: { raw: "MIXED", unbound: true } }))[0]!;
    expect(finding.currentValue).toBe("mixed");
  });

  it("refuses to bind when the token has no Figma variable", () => {
    const bare = context({ theme: themeSnapshot({ bindable: () => false }) });
    const finding = runRule(unboundFill, node({ fill: looseFill("#ffffff") }))[0]!;
    const proposal = unboundFill.propose!(finding, bare)!;
    expect(proposal).toMatchObject({ kind: "exact", bindable: false });
    expect((proposal as { unbindableReason: string }).unbindableReason).toContain("Create it");
  });

  it("refuses to bind when the Figma variable holds a different value", () => {
    // The dangerous case: binding would move the design, not describe it.
    const drifted = context({
      theme: themeSnapshot({ mismatched: new Set(["color.core_neu_00"]) }),
    });
    const finding = runRule(unboundFill, node({ fill: looseFill("#ffffff") }))[0]!;
    const proposal = unboundFill.propose!(finding, drifted)!;
    expect(proposal).toMatchObject({ bindable: false });
    expect((proposal as { unbindableReason: string }).unbindableReason).toContain(
      "would change the layer",
    );
  });
});

describe("F2 unbound-stroke", () => {
  it("reports a hardcoded border and proposes its token", () => {
    const root = node({ stroke: looseStroke("#ffffff") });
    expect(runRule(unboundStroke, root)[0]!.message).toContain("border");
    expect(proposalFor(unboundStroke, root)).toMatchObject({
      kind: "exact",
      tokenRef: "color.core_neu_00",
      target: { type: "paint", slot: "stroke" },
    });
  });
});

describe("F3 unbound-text-style", () => {
  it("matches the quadruple and targets a text style", () => {
    const root = node({
      type: "TEXT",
      text: looseText({ fontSize: 20, lineHeight: 28, fontWeight: 700, fontFamily: "Montserrat" }),
    });
    const finding = runRule(unboundTextStyle, root)[0]!;
    expect(finding.currentValue).toBe("20/28 700 Montserrat");
    expect(finding.detail).toMatchObject({ fontSize: 20, fontFamily: "Montserrat" });

    expect(proposalFor(unboundTextStyle, root)).toMatchObject({
      kind: "exact",
      tokenRef: "type.h1_bold",
      target: { type: "textStyle" },
    });
  });

  it("carries a font name with a space through to the match", () => {
    // Regression guard: the quadruple is read from `detail`, not re-parsed out of
    // the label, so "Semi Bold" cannot be mistaken for a weight and a family.
    const root = node({
      type: "TEXT",
      text: looseText({ fontWeight: "Semi Bold", fontFamily: "Noto Sans Devanagari" }),
    });
    const finding = runRule(unboundTextStyle, root)[0]!;
    expect(finding.detail?.fontWeight).toBe("Semi Bold");
    expect(finding.detail?.fontFamily).toBe("Noto Sans Devanagari");
  });

  it("never near-matches type", () => {
    const root = node({ type: "TEXT", text: looseText({ fontSize: 21 }) });
    const proposal = proposalFor(unboundTextStyle, root)!;
    expect(proposal.kind).toBe("none");
    expect((proposal as { hint: string }).hint).toContain("never near-matched");
  });
});

describe("F4 unbound-spacing", () => {
  it("proposes the spacing token for a gap", () => {
    const root = node({ layoutMode: "horizontal", gap: loose(10) });
    const finding = runRule(unboundSpacing, root)[0]!;
    expect(finding.currentValue).toBe("10");
    expect(finding.message).toContain("magic number");
    expect(proposalFor(unboundSpacing, root)).toMatchObject({
      kind: "exact",
      tokenRef: "space.2_5",
      target: { type: "nodeField", field: "itemSpacing" },
    });
  });

  it("targets the right padding field", () => {
    const root = node({ padding: { left: loose(16) } });
    expect(proposalFor(unboundSpacing, root)).toMatchObject({
      target: { type: "nodeField", field: "paddingLeft" },
    });
  });

  it("ignores zero — absent spacing is not a hardcoded value", () => {
    const root = node({ layoutMode: "horizontal", gap: loose(0), padding: { top: loose(0) } });
    expect(runRule(unboundSpacing, root)).toHaveLength(0);
  });

  it("offers the nearest spacing token for a subpixel value", () => {
    const root = node({ padding: { top: loose(13.481) } });
    expect(proposalFor(unboundSpacing, root)).toMatchObject({
      kind: "near",
      tokenRef: "space.3_5",
    });
  });

  it("skips a bound gap", () => {
    const root = node({ layoutMode: "horizontal", gap: bound(16) });
    expect(runRule(unboundSpacing, root)).toHaveLength(0);
  });
});

describe("F5 unbound-radius", () => {
  it("treats a loose zero radius as a decision nobody made", () => {
    const root = node({ radius: { value: 0, unbound: false } });
    const finding = runRule(unboundRadius, root)[0]!;
    expect(finding.currentValue).toBe("0");
    expect(finding.message).toContain("nobody having decided");
    expect(proposalFor(unboundRadius, root)).toMatchObject({
      kind: "exact",
      tokenRef: "radius.none",
      target: { type: "nodeField", field: "cornerRadius" },
    });
  });

  it("skips a radius that already has a variable", () => {
    const root = node({ radius: bound(0, "radius.none") });
    expect(runRule(unboundRadius, root)).toHaveLength(0);
  });

  it("offers the nearest radius token for a subpixel value", () => {
    const root = node({ radius: loose(10.4) });
    expect(proposalFor(unboundRadius, root)).toMatchObject({
      kind: "near",
    });
  });
});

describe("F6 unbound-effect", () => {
  it("reports a shadow without geometry and does not guess a token", () => {
    const root = node({ effects: [looseEffect("DROP_SHADOW")] });
    const finding = runRule(unboundEffect, root)[0]!;
    expect(finding.currentValue).toBe("drop-shadow");
    expect(finding.message).toContain("elevation scale");

    const proposal = proposalFor(unboundEffect, root)!;
    expect(proposal.kind).toBe("none");
    expect((proposal as { reason: string }).reason).toContain("isn't in this IR");
  });

  it("proposes the matching effect style when geometry is present", () => {
    const root = node({
      effects: [
        looseEffect("DROP_SHADOW", {
          x: 3,
          y: 3,
          blur: 4,
          spread: 0,
          color: "#1A1A1A",
          opacity: 100,
          inset: false,
        }),
      ],
    });
    const proposal = proposalFor(unboundEffect, root)!;
    expect(proposal).toMatchObject({
      kind: "exact",
      tokenRef: "shadow.md",
      target: { type: "effectStyle" },
      bindable: true,
    });
  });
});

describe("W1 default-layer-names", () => {
  it("matches the names Figma hands out", () => {
    for (const name of ["Frame 427", "Group", "Rectangle 12", "image 3", "Union", "Vector_2"]) {
      expect(DEFAULT_NAME_RE.test(name)).toBe(true);
    }
    for (const name of ["Hero", "player-card", "Frame with a name", "CTA Button"]) {
      expect(DEFAULT_NAME_RE.test(name)).toBe(false);
    }
  });

  it("excludes vectors from the percentage", () => {
    const root = node({
      name: "Home",
      children: [
        node({ name: "Frame 1" }),
        node({ name: "hero" }),
        node({ name: "Vector 1", type: "VECTOR" }),
        node({ name: "Vector 2", type: "VECTOR" }),
      ],
    });
    const finding = runRule(defaultLayerNames, root)[0]!;
    // 1 of 3 non-vector nodes, not 3 of 5.
    expect(finding.detail).toMatchObject({
      defaultNamed: 1,
      consideredNodes: 3,
      excludedVectors: 2,
    });
  });
});

describe("lint()", () => {
  it("splits findings by severity and never proposes for a blocker", () => {
    const root = withDepths(
      node({
        layoutMode: "none",
        width: 1366,
        children: [node({ type: "GROUP", children: [node({ fill: looseFill("#ffffff") })] })],
      }),
    );
    const report = lint(document(root), ctx);
    expect(report.blockers).toHaveLength(3);
    expect(report.batches.every((b) => b.ruleCode.startsWith("F"))).toBe(true);
  });
});
