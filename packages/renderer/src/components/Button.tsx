/**
 * Button — the first primitive that is not a rectangle.
 *
 * A compiled frame renders a button perfectly at rest and is wrong in every
 * other respect: it is a `div`, so it is not focusable, not activated by
 * Enter or Space, invisible to a screen reader, and it has one frozen colour
 * where the theme ships three states. None of that is recoverable from
 * geometry, which is exactly why this node type exists.
 *
 * The element is chosen by the ACTION, not by styling:
 *
 *   navigate  <a href>          — a link is a link; Cmd-click, middle-click and
 *                                 "copy link address" all have to keep working
 *   submit    <button type=submit>
 *   none/open <button type=button>
 *
 * No client JavaScript. Hover, focus and disabled are CSS state on a real
 * element, so this stays a Server Component like everything else in the SDK.
 * `open` is the one action that genuinely needs a handler; it renders the
 * correct element and marks it with `data-fos-open` for the host to wire,
 * rather than pretending to work.
 *
 * Colour comes from the token family the theme already publishes —
 * `button_<variant>_style_<n>_<part>_<state>` — resolved into custom properties
 * here so the stylesheet can carry ONE set of rules for every variant. A family
 * that does not exist (link has no surface) simply leaves its property unset,
 * and the fallback in the stylesheet applies.
 */

import type { Node } from "@fanos/dsl";
import { cssClassName, cssVar } from "@fanos/tokens";
import { resolveNode } from "../resolve/style.js";
import { formatUnresolvedWarnings, interpolate } from "../resolve/data.js";
import type { NodeRenderContext } from "../context.js";
import { styleToReact } from "./dom.js";
import { renderIcon } from "./icons.js";

type Action =
  | { kind: "none" }
  | { kind: "navigate"; href: string; external?: boolean }
  | { kind: "open"; target: string }
  | { kind: "submit"; form?: string };

const SIZES = new Set(["sm", "md", "lg"]);

/**
 * Padding per size.
 *
 * The theme's `button.size` group is empty, so there is nothing to bind to and
 * these are a convention rather than a token read. Space tokens rather than
 * pixels, so a tenant re-scaling its spacing still moves buttons, and the
 * universal `space` prop overrides them for a design that disagrees.
 */
const PADDING: Record<string, { px: string; py: string }> = {
  sm: { px: "space.3", py: "space.1_5" },
  md: { px: "space.5", py: "space.2_5" },
  lg: { px: "space.6", py: "space.3_5" },
};

/** The glyph size that sits with each label size without dominating it. */
const ICON_PX: Record<string, number> = { sm: 14, md: 16, lg: 20 };

function actionOf(value: unknown): Action {
  if (!value || typeof value !== "object") return { kind: "none" };
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "navigate") {
    const href = (value as { href?: unknown }).href;
    if (typeof href !== "string") return { kind: "none" };
    return { kind: "navigate", href, external: (value as { external?: boolean }).external };
  }
  if (kind === "open") {
    const target = (value as { target?: unknown }).target;
    return typeof target === "string" ? { kind: "open", target } : { kind: "none" };
  }
  if (kind === "submit") {
    const form = (value as { form?: unknown }).form;
    return typeof form === "string" ? { kind: "submit", form } : { kind: "submit" };
  }
  return { kind: "none" };
}

/** `color.button_filled_style_2_surface_on_hover`, if the theme publishes it. */
function paint(variant: string, styleN: number, part: string, state: string): string {
  // `no-padding` is spelled with an underscore in the token names.
  const family = variant.replace(/-/g, "_");
  return cssVar(`color.button_${family}_style_${styleN}_${part}_${state}`);
}

export function Button({ node, ctx }: { node: Node; ctx: NodeRenderContext }) {
  const props = node.props as Record<string, unknown>;
  const resolved = resolveNode(props, { flexChild: ctx.flexChild });

  const variant = typeof props.variant === "string" ? props.variant : "filled";
  const styleN = typeof props.styleN === "number" ? props.styleN : 1;
  const size = typeof props.size === "string" && SIZES.has(props.size) ? props.size : "md";
  const disabled = props.disabled === true;
  const loading = props.loading === true;
  const action = actionOf(props.action);

  // The label is content, so it interpolates like any other bound string.
  const labelRaw = typeof props.label === "string" ? props.label : "";
  const { value: label, unresolved } = interpolate(labelRaw, ctx.data);
  if (unresolved.length) {
    for (const w of formatUnresolvedWarnings(node.id, "label", unresolved)) console.warn(w);
  }

  const pad = PADDING[size]!;
  const declaredSpace = props.space as Record<string, unknown> | undefined;
  const style: Record<string, string> = {
    ...resolved.style,
    "--fos-btn-surface": paint(variant, styleN, "surface", "default"),
    "--fos-btn-surface-hover": paint(variant, styleN, "surface", "on_hover"),
    "--fos-btn-surface-disabled": paint(variant, styleN, "surface", "disable"),
    "--fos-btn-text": paint(variant, styleN, "text", "default"),
    "--fos-btn-text-hover": paint(variant, styleN, "text", "on_hover"),
    "--fos-btn-text-disabled": paint(variant, styleN, "text", "disable"),
    "--fos-btn-border": paint(variant, styleN, "border", "default"),
    "--fos-btn-border-hover": paint(variant, styleN, "border", "on_hover"),
    "--fos-btn-border-disabled": paint(variant, styleN, "border", "disable"),
  };
  // A declared `space` has already been mapped by resolveNode; only fill in the
  // convention where the author said nothing.
  if (!declaredSpace?.px && !declaredSpace?.p) style.paddingInline = cssVar(pad.px);
  if (!declaredSpace?.py && !declaredSpace?.p) style.paddingBlock = cssVar(pad.py);

  const classes = [
    "fos-button",
    `fos-button-${variant}`,
    cssClassName("type", `button_${size}`),
    resolved.className,
  ].join(" ");

  const iconPx = ICON_PX[size]!;
  const iconStart = typeof props.iconStart === "string" ? props.iconStart : undefined;
  const iconEnd = typeof props.iconEnd === "string" ? props.iconEnd : undefined;
  const inner = (
    <>
      {iconStart ? renderIcon(iconStart, { size: iconPx, color: "currentColor" }) : null}
      <span className="fos-button-label">{label}</span>
      {iconEnd ? renderIcon(iconEnd, { size: iconPx, color: "currentColor" }) : null}
    </>
  );

  const shared = {
    className: classes,
    style: styleToReact(style),
    "data-fos-id": node.id,
    "data-fos-type": "Button",
    "data-fos-variant": `${variant}-${styleN}`,
    ...(loading ? { "aria-busy": "true" as const } : {}),
    ...resolved.dataAttrs,
  };

  /**
   * A disabled link is not a thing HTML has. Dropping the href is what actually
   * makes it unclickable and unfocusable; `aria-disabled` is what tells a
   * screen reader why.
   */
  if (action.kind === "navigate") {
    const inert = disabled || loading;
    return (
      <a
        {...shared}
        {...(inert ? { "aria-disabled": "true" as const, role: "link" } : { href: action.href })}
        {...(action.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      >
        {inner}
      </a>
    );
  }

  return (
    <button
      {...shared}
      type={action.kind === "submit" ? "submit" : "button"}
      disabled={disabled || loading}
      {...(action.kind === "submit" && action.form ? { form: action.form } : {})}
      {...(action.kind === "open" ? { "data-fos-open": action.target } : {})}
    >
      {inner}
    </button>
  );
}
