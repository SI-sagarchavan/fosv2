/**
 * Button — the parts a rectangle cannot carry.
 *
 * A compiled frame already renders a button correctly at rest, so pixels are
 * not what these test. What they test is everything the `div` version got
 * wrong: the element, the states, and whether a keyboard or a screen reader can
 * use the thing at all.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { Node } from "@fanos/dsl";
import { Button } from "../src/components/Button.js";
import type { NodeRenderContext } from "../src/context.js";

const render = (props: Record<string, unknown>, ctx: NodeRenderContext = {}) =>
  renderToStaticMarkup(
    createElement(Button, {
      node: { id: "cta", type: "Button", src: "1:1", props } as unknown as Node,
      ctx,
    }),
  );

const base = {
  label: "MATCH CENTER",
  variant: "filled",
  styleN: 2,
  size: "md",
  action: { kind: "none" },
};

describe("the element follows the action, not the styling", () => {
  it("renders a real button by default", () => {
    const html = render(base);
    expect(html).toMatch(/^<button/);
    expect(html).toContain('type="button"');
  });

  /**
   * A link has to stay a link: Cmd-click, middle-click and "copy link address"
   * are the behaviours a `div` with an onClick silently removes.
   */
  it("renders an anchor for a navigate action", () => {
    const html = render({ ...base, action: { kind: "navigate", href: "/match/123" } });
    expect(html).toMatch(/^<a/);
    expect(html).toContain('href="/match/123"');
  });

  it("opens an external link safely", () => {
    const html = render({
      ...base,
      action: { kind: "navigate", href: "https://x.test", external: true },
    });
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("renders a submit button that can name its form", () => {
    const html = render({ ...base, action: { kind: "submit", form: "signup" } });
    expect(html).toContain('type="submit"');
    expect(html).toContain('form="signup"');
  });

  /**
   * `open` is the one action that needs a handler. It renders the right element
   * and marks it, rather than pretending to work.
   */
  it("marks an open action for the host to wire", () => {
    expect(render({ ...base, action: { kind: "open", target: "menu" } })).toContain(
      'data-fos-open="menu"',
    );
  });
});

describe("state", () => {
  it("disables the native control, so it is unfocusable and unclickable", () => {
    expect(render({ ...base, disabled: true })).toContain("disabled=");
  });

  /**
   * HTML has no disabled anchor. Dropping the href is what makes it inert;
   * aria-disabled is what explains why.
   */
  it("makes a disabled link inert by removing its href", () => {
    const html = render({ ...base, action: { kind: "navigate", href: "/x" }, disabled: true });
    expect(html).not.toContain('href="/x"');
    expect(html).toContain('aria-disabled="true"');
  });

  it("announces loading and stops it being pressed twice", () => {
    const html = render({ ...base, loading: true });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("disabled=");
  });
});

describe("theming", () => {
  /**
   * The whole point of the token family: three states ship with the theme, and
   * the compiled Stack could only ever carry the one it was drawn in.
   */
  it("wires every state of its variant's family to custom properties", () => {
    const html = render(base);
    expect(html).toContain("--fos-btn-surface:var(--fos-color-button-filled-style-2-surface-default)");
    expect(html).toContain("--fos-btn-surface-hover:var(--fos-color-button-filled-style-2-surface-on-hover)");
    expect(html).toContain("--fos-btn-text-disabled:var(--fos-color-button-filled-style-2-text-disable)");
  });

  it("follows variant and styleN into a different family", () => {
    const html = render({ ...base, variant: "outline", styleN: 3 });
    expect(html).toContain("--fos-btn-border:var(--fos-color-button-outline-style-3-border-default)");
    expect(html).toContain("fos-button-outline");
  });

  /** `no-padding` is spelled with an underscore in the token names. */
  it("maps a hyphenated variant onto its token family", () => {
    expect(render({ ...base, variant: "no-padding", styleN: 1 })).toContain(
      "--fos-btn-text:var(--fos-color-button-no-padding-style-1-text-default)",
    );
  });

  it("takes its label type from the size", () => {
    expect(render({ ...base, size: "lg" })).toContain("fos-type-button_lg");
    expect(render(base)).toContain("fos-type-button_md");
  });

  /** The theme ships no `button.size` group, so padding is a convention — but
   * an authored `space` still wins, because the design is the authority. */
  it("applies the size convention for padding, and yields to a declared space", () => {
    expect(render(base)).toContain("padding-inline:var(--fos-space-5)");
    const declared = render({ ...base, space: { px: "space.10" } });
    expect(declared).toContain("var(--fos-space-10)");
    expect(declared).not.toContain("padding-inline:var(--fos-space-5)");
  });
});

/**
 * The type token has to win.
 *
 * `<button>` carries a UA font, and the obvious fix — `font: inherit` on
 * `.fos-button` — is wrong here: these rules are emitted AFTER the theme's
 * `.fos-type-*` rules at equal specificity, so the reset wins the cascade and
 * silently wipes the token. The news section's VIEW MORE label rendered in the
 * UA serif with its type class present and losing. The type class is the only
 * thing that should set the face.
 */
describe("the stylesheet does not fight the type token", () => {
  const sheet = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const block = /\.fos-button \{([\s\S]*?)\}/.exec(sheet)?.[1] ?? "";

  it("has a .fos-button rule at all", () => {
    expect(block).toContain("--fos-btn-surface");
  });

  it("declares no font of its own", () => {
    expect(block).not.toMatch(/(^|[;{\s])font(-family|-size|-weight)?\s*:/);
  });
});

describe("content", () => {
  it("interpolates a bound label", () => {
    expect(render({ ...base, label: "{cta.label}" }, { data: { cta: { label: "BUY" } } })).toContain(
      "BUY",
    );
  });

  it("renders leading and trailing glyphs", () => {
    const html = render({ ...base, iconStart: "search", iconEnd: "arrow_up_right" });
    expect((html.match(/<svg/g) ?? []).length).toBe(2);
  });

  it("keeps the node addressable for the repair loop", () => {
    const html = render(base);
    expect(html).toContain('data-fos-id="cta"');
    expect(html).toContain('data-fos-type="Button"');
  });
});
