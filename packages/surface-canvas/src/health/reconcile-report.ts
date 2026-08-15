/**
 * The reconciliation report. PURE — no Figma import.
 *
 * The theme JSON and the Figma file are two separate sources of truth and they
 * will not match. Which tokens have a variable behind them decides which batches
 * can be offered at all, so this is not diagnostics — it is the reason a button
 * is enabled or disabled, and it is a design-ops finding in its own right.
 *
 * A token with no Figma variable is surfaced and its batch is disabled with the
 * reason attached. It is never offered as a button that fails.
 */
import type { Category } from "@fanos/tokens";
import type { OrphanBinding, ThemeSnapshot, TokenBinding } from "./types.js";

export interface MissingToken {
  ref: string;
  raw: string;
  category: Category;
  /** Rendered value, so the report reads as something a designer can create. */
  value: string;
}

export interface MismatchedToken extends MissingToken {
  figmaName: string;
  /** What the variable actually holds. */
  figmaValue: string;
  /** Library / remote variables cannot be reset from this file. */
  medium?: TokenBinding["medium"];
  remote?: boolean;
}

export interface CategoryTally {
  category: Category;
  total: number;
  bindable: number;
  missing: number;
  mismatched: number;
}

export interface ReconciliationReport {
  themeId: string;
  themeName: string;
  total: number;
  bindable: number;
  /** Tokens with no Figma variable or style — autofix is impossible for these. */
  missing: MissingToken[];
  /**
   * Tokens whose variable exists and holds something else. Worse than missing:
   * these are the ones that would have moved the design if the value check
   * weren't there.
   */
  mismatched: MismatchedToken[];
  /** Figma variables and styles with no token behind them. */
  orphans: OrphanBinding[];
  byCategory: CategoryTally[];
  reconciled: boolean;
  /** Zero means every variable in this file comes from a published library. */
  localCollections: number;
  /** Enabled libraries publishing variables — the other place bindings come from. */
  libraryCollections: number;
  /** Why the library lookup failed, when it did. */
  libraryError?: string;
  /** Bindable tokens that will be imported from a library on first use. */
  fromLibrary: number;
}

interface Row {
  ref: string;
  raw: string;
  category: Category;
  value: string;
  binding?: TokenBinding;
}

export function reconciliationReport(snapshot: ThemeSnapshot): ReconciliationReport {
  const rows: Row[] = [
    ...snapshot.colors.map((c) => row(c.ref, c.raw, "color", c.hex, c.binding)),
    ...snapshot.spaces.map((s) => row(s.ref, s.raw, "space", `${s.px}px`, s.binding)),
    ...snapshot.radii.map((r) => row(r.ref, r.raw, "radius", `${r.px}px`, r.binding)),
    ...snapshot.types.map((t) => row(t.ref, t.raw, "type", typeValue(t.byBreakpoint), t.binding)),
    ...snapshot.shadows.map((s) => row(s.ref, s.raw, "shadow", s.value, s.binding)),
    ...snapshot.gradients.map((g) => row(g.ref, g.raw, "gradient", g.value, g.binding)),
  ];

  const byCategory = new Map<Category, CategoryTally>();
  const missing: MissingToken[] = [];
  const mismatched: MismatchedToken[] = [];

  for (const r of rows) {
    let tally = byCategory.get(r.category);
    if (!tally) {
      tally = { category: r.category, total: 0, bindable: 0, missing: 0, mismatched: 0 };
      byCategory.set(r.category, tally);
    }
    tally.total++;

    const base = { ref: r.ref, raw: r.raw, category: r.category, value: r.value };
    if (!r.binding) {
      tally.missing++;
      missing.push(base);
    } else if (r.binding.valueMatches === false) {
      tally.mismatched++;
      mismatched.push({
        ...base,
        figmaName: r.binding.figmaName,
        figmaValue: r.binding.figmaValue ?? "a different value",
        medium: r.binding.medium,
        ...(r.binding.remote ? { remote: true } : {}),
      });
    } else {
      tally.bindable++;
    }
  }

  return {
    themeId: snapshot.themeId,
    themeName: snapshot.themeName,
    total: rows.length,
    bindable: rows.length - missing.length - mismatched.length,
    missing,
    mismatched,
    orphans: snapshot.orphans,
    byCategory: [...byCategory.values()].sort((a, b) => b.total - a.total),
    reconciled: snapshot.reconciled,
    localCollections: snapshot.localCollections,
    libraryCollections: snapshot.libraryCollections,
    ...(snapshot.libraryError ? { libraryError: snapshot.libraryError } : {}),
    fromLibrary: rows.filter((r) => r.binding?.medium === "libraryVariable").length,
  };
}

function row(
  ref: string,
  raw: string,
  category: Category,
  value: string,
  binding: TokenBinding | undefined,
): Row {
  return binding ? { ref, raw, category, value, binding } : { ref, raw, category, value };
}

function typeValue(byBreakpoint: ThemeSnapshot["types"][number]["byBreakpoint"]): string {
  const style = byBreakpoint.desktop ?? byBreakpoint.tablet ?? byBreakpoint.mobile;
  if (!style) return "—";
  return `${style.size}/${style.lineHeight} ${style.weight} ${style.family}`;
}
