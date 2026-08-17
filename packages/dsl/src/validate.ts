/**
 * Part 6 — Validator.
 *
 * Gates every generated tree before render. Structural and token problems are
 * ERRORS; quality signals are COUNTED and never block.
 *
 * PURE. No filesystem, no process, no clock — `tests/purity.test.ts` enforces
 * it, and every validator test runs against in-memory objects.
 */

import type { Registry } from "@fanos/tokens";
import { DEFAULT_BREAKPOINTS } from "@fanos/tokens";
import { reify, ReifyError, rootOf, type FlatNode, type FlatTree } from "./flat.js";
import { allFields, nodeSpec } from "./nodes/index.js";
import { analyze, type Metrics } from "./metrics.js";
import { suggestRefs } from "./suggest.js";
import { isRespObject, isSignedTokenRef, refCategory, SEMVER_REF_RE, unsignRef } from "./values.js";
import { LAYOUT_PROP_NAMES, REPEATER_FORBIDDEN_PROPS } from "./universal.js";
import { walkProps } from "./walk.js";
import { zodOfFields, type FieldType } from "./field.js";

export const ISSUE_CODES = [
  "S1", // reify failed: cycle, orphan, multi-root, idx gap
  "S2", // unknown node type
  "S3", // missing or duplicate id; missing src
  "S4", // Section not a direct child of root
  "S5", // Repeater carrying layout/space/size/surface props
  "S6", // place.anchor under a parent that cannot position it
  "S7", // place.span on a node whose parent is not Grid
  "S8", // Overlay child with no place.anchor
  "S9", // Grid columns:"auto" with no minItemWidth
  "S10", // Carousel with control nodes among its children (warning, heuristic)
  "S11", // Custom.ref not name@semver
  "S12", // a prop failed its schema (shape, not resolution)
  "T1", // token ref does not resolve
  "T2", // Text.style is not a TypeToken
  "T3", // Resp<> wrapper around a TypeToken
  "T4", // Resp breakpoint key not in the tokens package config
  "T5", // ref resolves but is the wrong category for this prop
] as const;

export type IssueCode = (typeof ISSUE_CODES)[number];

export interface Issue {
  code: IssueCode;
  severity: "error" | "warning";
  message: string;
  nodeId?: string;
  /** Dotted prop path within the node, when the issue is prop-scoped. */
  path?: string;
  /** Up to three near misses from the token registry (T1). */
  suggestions?: string[];
}

export interface ValidateOptions {
  registry: Registry;
  /** Defaults to the tokens package's own breakpoint keys. */
  breakpointKeys?: readonly string[];
}

export interface ValidationResult {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  metrics: Metrics;
}

export { analyze };

/** Field kinds whose value must be a resolvable ref of a specific category. */
function expectedCategory(type: FieldType): string | undefined {
  if (type.k === "token") return type.category;
  if (type.k === "val") return type.category;
  if (type.k === "size" || type.k === "offset") return "space";
  return undefined;
}

/**
 * Parents that can honour `place.anchor`.
 *
 * An Overlay positions every child (S8). A Stack positions the children that
 * opt OUT of its flow — which is a real thing Figma does and CSS does: an
 * absolutely-positioned child of an auto-layout frame anchors to that frame
 * while its siblings keep flowing. Both render as `position: absolute` inside a
 * `position: relative` box, and the renderer has always drawn it correctly.
 *
 * Excluding Stack forced the compiler to demote any auto-layout frame with one
 * absolute child to an Overlay — which anchors ALL of its children and throws
 * the row away. On the fixtures page that collapsed a 333px button row to 72px
 * and shifted its subtree by 262px.
 *
 * Leaves and fragments stay excluded, which is the rule's real job: a Repeater
 * under a Stack makes its children flex items, and an anchor there is
 * meaningless because nothing will ever honour it.
 */
const ANCHORS_CHILDREN = new Set(["Overlay", "Stack"]);

/** Chrome a Carousel renders itself; finding it as a child node is the S10 smell. */
const CONTROL_SRC_RE = /(arrow|chevron|dot|pagination|counter|prev|next)/i;

export function validate(tree: FlatTree, options: ValidateOptions): ValidationResult {
  const { registry } = options;
  const breakpointKeys = options.breakpointKeys ?? Object.keys(DEFAULT_BREAKPOINTS);
  const issues: Issue[] = [];
  const add = (issue: Issue) => issues.push(issue);

  // --- S3: identity ------------------------------------------------------
  const seenIds = new Set<string>();
  for (const node of tree.nodes) {
    if (!node.id) {
      add({ code: "S3", severity: "error", message: "node is missing an id" });
    } else if (seenIds.has(node.id)) {
      add({ code: "S3", severity: "error", nodeId: node.id, message: `duplicate node id "${node.id}"` });
    } else {
      seenIds.add(node.id);
    }
    if (!node.src) {
      add({
        code: "S3",
        severity: "error",
        nodeId: node.id,
        message: `node "${node.id}" is missing src — every node needs a Figma origin (or a synthetic: id) for the repair loop`,
      });
    }
  }

  // --- S1: the tree must fold up -----------------------------------------
  try {
    reify(tree);
  } catch (error) {
    const detail = error instanceof ReifyError ? error : undefined;
    add({
      code: "S1",
      severity: "error",
      message: `tree does not reify: ${error instanceof Error ? error.message : String(error)}`,
      ...(detail?.nodeIds[0] ? { nodeId: detail.nodeIds[0] } : {}),
    });
  }

  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const root = rootOf(tree);
  const parentOf = (node: FlatNode): FlatNode | undefined =>
    node.parent === null ? undefined : byId.get(node.parent);

  /**
   * The node whose layout actually governs this one.
   *
   * A fragment emits its children into ITS parent's layout, so a Repeater under
   * an Overlay makes its children Overlay children — they need `place.anchor`
   * — while a Repeater under a Stack makes them flex items, where an anchor is
   * meaningless. Comparing against the immediate parent gets both backwards.
   */
  const layoutParentOf = (node: FlatNode): FlatNode | undefined => {
    let p = parentOf(node);
    while (p && nodeSpec(p.type)?.fragment) p = parentOf(p);
    return p;
  };

  // Paths already explained by a token rule, so the shape check does not
  // report the same value twice in different words.
  const covered = new Set<string>();
  const cover = (nodeId: string, path: string) => covered.add(`${nodeId} ${path}`);

  for (const node of tree.nodes) {
    const spec = nodeSpec(node.type);

    // --- S2 -------------------------------------------------------------
    if (!spec) {
      add({
        code: "S2",
        severity: "error",
        nodeId: node.id,
        message: `unknown node type "${node.type}"`,
      });
      continue;
    }

    const parent = parentOf(node);
    const layoutParent = layoutParentOf(node);
    const fields = allFields(spec);

    // --- S4 -------------------------------------------------------------
    if (node.type === "Section" && root && node.id !== root.id && node.parent !== root.id) {
      add({
        code: "S4",
        severity: "error",
        nodeId: node.id,
        message: `Section "${node.id}" must be a direct child of the root, not of "${node.parent}"`,
      });
    }

    // --- S5 -------------------------------------------------------------
    if (spec.fragment) {
      const forbidden = [...REPEATER_FORBIDDEN_PROPS, ...LAYOUT_PROP_NAMES];
      for (const prop of forbidden) {
        if (node.props[prop] === undefined) continue;
        add({
          code: "S5",
          severity: "error",
          nodeId: node.id,
          path: prop,
          message: `${node.type} is a fragment and cannot carry "${prop}" — it emits its children into the parent's layout and has no box of its own`,
        });
        cover(node.id, prop);
      }
    }

    // --- S6 / S7 / S8 ----------------------------------------------------
    const place = node.props["place"] as Record<string, unknown> | undefined;
    if (place && typeof place === "object") {
      if (place["anchor"] !== undefined && !ANCHORS_CHILDREN.has(layoutParent?.type ?? "")) {
        add({
          code: "S6",
          severity: "error",
          nodeId: node.id,
          path: "place.anchor",
          message: `place.anchor needs a parent that can position it (${[...ANCHORS_CHILDREN].join(" or ")}); "${node.id}" lays out under ${layoutParent ? `a ${layoutParent.type}` : "no parent"}`,
        });
      }
      if (place["span"] !== undefined && layoutParent?.type !== "Grid") {
        add({
          code: "S7",
          severity: "error",
          nodeId: node.id,
          path: "place.span",
          message: `place.span is only meaningful under a Grid; "${node.id}" lays out under ${layoutParent ? `a ${layoutParent.type}` : "no parent"}`,
        });
      }
    }

    // Every Overlay child must say where it goes. Two siblings sharing an
    // anchor is LEGAL — that is how layering works — and is never flagged.
    if (layoutParent?.type === "Overlay" && (!place || (place as Record<string, unknown>)["anchor"] === undefined)) {
      add({
        code: "S8",
        severity: "error",
        nodeId: node.id,
        path: "place.anchor",
        message: `"${node.id}" is an Overlay child and must declare place.anchor`,
      });
    }

    // --- S9 --------------------------------------------------------------
    if (node.type === "Grid") {
      const columns = node.props["columns"];
      const usesAuto = columns === "auto" || (isRespObject(columns) && Object.values(columns).includes("auto"));
      if (usesAuto && node.props["minItemWidth"] === undefined) {
        add({
          code: "S9",
          severity: "error",
          nodeId: node.id,
          path: "minItemWidth",
          message: `Grid "${node.id}" uses columns:"auto" and must declare minItemWidth`,
        });
      }
    }

    // --- S10 (heuristic, warning) ----------------------------------------
    if (node.type === "Carousel") {
      for (const child of tree.nodes.filter((n) => n.parent === node.id)) {
        if (child.type !== "Icon" && child.type !== "Button") continue;
        if (!CONTROL_SRC_RE.test(child.src)) continue;
        add({
          code: "S10",
          severity: "warning",
          nodeId: child.id,
          message: `"${child.id}" (${child.type}, src ${child.src}) looks like Carousel chrome — controls are rendered by the Carousel and are never nodes in the tree`,
        });
      }
    }

    // --- S11 -------------------------------------------------------------
    if (node.type === "Custom") {
      const ref = node.props["ref"];
      if (typeof ref !== "string" || !SEMVER_REF_RE.test(ref)) {
        add({
          code: "S11",
          severity: "error",
          nodeId: node.id,
          path: "ref",
          message: `Custom.ref must be \`name@1.2.3\`, got ${JSON.stringify(ref)}`,
        });
        cover(node.id, "ref");
      }
    }

    // --- T rules ----------------------------------------------------------
    walkProps(fields, node.props, {
      resp: ({ path, keys, field }) => {
        // T3 — a Resp wrapper where the value is already responsive.
        if (!field.resp) {
          const isTypeToken = field.type.k === "token" && field.type.category === "type";
          if (isTypeToken) {
            add({
              code: "T3",
              severity: "error",
              nodeId: node.id,
              path,
              message: `${path} is a type token and is ALREADY responsive — @fanos/tokens resolves type.* per breakpoint, so wrapping it in { base, ${breakpointKeys.join(", ")} } creates two competing responsive systems`,
            });
          } else {
            add({
              code: "S12",
              severity: "error",
              nodeId: node.id,
              path,
              message: `${path} is not a responsive prop but was given a { base, … } wrapper`,
            });
          }
          cover(node.id, path);
          return;
        }
        // T4 — keys must match the tokens package config exactly.
        for (const key of keys) {
          if (key === "base" || breakpointKeys.includes(key)) continue;
          add({
            code: "T4",
            severity: "error",
            nodeId: node.id,
            path: `${path}.${key}`,
            message: `"${key}" is not a breakpoint in the tokens package config (have: base, ${breakpointKeys.join(", ")})`,
          });
          cover(node.id, path);
        }
      },

      leaf: ({ path, value, type }) => {
        // T2 — Text.style must be a type token, whatever else it resolves to.
        if (node.type === "Text" && path === "style") {
          if (typeof value !== "string" || refCategory(value) !== "type") {
            add({
              code: "T2",
              severity: "error",
              nodeId: node.id,
              path,
              message: `Text.style must be a TypeToken, got ${JSON.stringify(value)}`,
              suggestions: typeof value === "string" ? suggestRefs(registry, `type.${value}`) : [],
            });
            cover(node.id, path);
            return;
          }
        }

        if (typeof value !== "string" || !isSignedTokenRef(value)) return;

        const wanted = expectedCategory(type);
        const actual = refCategory(value);

        // T5 — resolves, but not the kind of token this prop takes.
        if (wanted && actual && actual !== wanted) {
          add({
            code: "T5",
            severity: "error",
            nodeId: node.id,
            path,
            message: `${path} takes a ${wanted} token, got a ${actual} token (${value})`,
            suggestions: suggestRefs(registry, `${wanted}.${unsignRef(value).slice(actual.length + 1)}`),
          });
          cover(node.id, path);
          return;
        }

        // T1 — the ref is well-formed and the right category, but nothing has it.
        if (!registry.has(unsignRef(value))) {
          add({
            code: "T1",
            severity: "error",
            nodeId: node.id,
            path,
            message: `"${value}" on node "${node.id}" at ${path} does not resolve in this theme`,
            suggestions: suggestRefs(registry, value),
          });
          cover(node.id, path);
        }
      },
    });

    // --- S12: shape ------------------------------------------------------
    const parsed = zodOfFields(fields, breakpointKeys).safeParse(node.props);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = issue.path.join(".");
        // An unrecognized-key issue lists its keys rather than pointing at one,
        // so it is dropped only once EVERY key it names has been explained.
        if (issue.code === "unrecognized_keys") {
          const unexplained = issue.keys.filter((k) => !covered.has(`${node.id} ${k}`));
          if (unexplained.length === 0) continue;
        }
        // Suppress anything a token rule already explained in better words.
        if (covered.has(`${node.id} ${path}`)) continue;
        if ([...covered].some((key) => key.startsWith(`${node.id} ${path}.`))) continue;
        add({
          code: "S12",
          severity: "error",
          nodeId: node.id,
          path: path || undefined,
          message: `${path || "props"}: ${issue.message}`,
        });
      }
    }
  }

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    // Reported whether or not the tree validates: a broken tree's raw-value
    // count is still the number design ops needs, and withholding it would make
    // the metric disappear exactly when someone is working on the tree.
    metrics: analyze(tree),
  };
}

export function issuesByCode(result: ValidationResult, code: IssueCode): Issue[] {
  return [...result.errors, ...result.warnings].filter((i) => i.code === code);
}
