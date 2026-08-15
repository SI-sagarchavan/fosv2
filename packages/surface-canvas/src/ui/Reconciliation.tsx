/**
 * This file vs the theme.
 *
 * Collapsed, at the bottom. The queue already says which batches can bind;
 * this is the inventory: tokens the theme has that Figma has never heard of,
 * variables that drifted, orphans with no token.
 */
import type { ReconciliationReport } from "../health/reconcile-report.js";
import type { JSX } from "react";

const MAX_LISTED = 12;

export function Reconciliation({
  reconciliation,
}: {
  reconciliation: ReconciliationReport | null;
}): JSX.Element | null {
  if (!reconciliation) return null;
  const { total, bindable, missing, mismatched, orphans, localCollections, libraryCollections, fromLibrary } =
    reconciliation;

  return (
    <details className="section">
      <summary className="row">
        <span className="grow">
          This file vs {reconciliation.themeName}{" "}
          <span className="muted">
            {bindable} / {total} tokens exist here
          </span>
        </span>
        <span className="muted">›</span>
      </summary>

      <SourceLine
        localCollections={localCollections}
        libraryCollections={libraryCollections}
        fromLibrary={fromLibrary}
        libraryError={reconciliation.libraryError}
      />

      {mismatched.length > 0 ? (
        <>
          <h4 style={{ margin: "10px 0 4px", color: "var(--fos-warn)" }}>
            {mismatched.length} {mismatched.length === 1 ? "variable holds" : "variables hold"} a
            different value
          </h4>
          <p className="muted" style={{ margin: "0 0 4px" }}>
            Binding these would change the design rather than describe it, so they're switched off.
          </p>
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {mismatched.slice(0, MAX_LISTED).map((token) => (
              <li key={token.ref}>
                <span className="mono">{token.figmaName}</span> is {token.figmaValue}
                <span className="muted">, theme says {token.value}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {missing.length > 0 ? (
        <>
          <h4 style={{ margin: "10px 0 4px" }}>{missing.length} tokens have no Figma variable</h4>
          <p className="muted" style={{ margin: "0 0 4px" }}>
            The queue offers Add on any exact batch that needs one of these.
          </p>
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {missing.slice(0, MAX_LISTED).map((token) => (
              <li key={token.ref}>
                <span className="mono">{token.raw}</span>{" "}
                <span className="muted">
                  {token.category} · {token.value}
                </span>
              </li>
            ))}
          </ul>
          {missing.length > MAX_LISTED ? (
            <div className="muted">+{missing.length - MAX_LISTED} more</div>
          ) : null}
        </>
      ) : null}

      {orphans.length > 0 ? (
        <>
          <h4 style={{ margin: "10px 0 4px" }}>
            {orphans.length} Figma {orphans.length === 1 ? "variable has" : "variables have"} no
            token
          </h4>
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {orphans.slice(0, MAX_LISTED).map((orphan) => (
              <li key={`${orphan.medium}-${orphan.figmaName}`}>
                <span className="mono">{orphan.figmaName}</span>{" "}
                <span className="muted">{orphan.collection ?? orphan.medium}</span>
              </li>
            ))}
          </ul>
          {orphans.length > MAX_LISTED ? (
            <div className="muted">+{orphans.length - MAX_LISTED} more</div>
          ) : null}
        </>
      ) : null}

      <div className="row muted" style={{ marginTop: 8, flexWrap: "wrap", gap: 8 }}>
        {reconciliation.byCategory.map((tally) => (
          <span key={tally.category}>
            {tally.category} {tally.bindable}/{tally.total}
          </span>
        ))}
      </div>
    </details>
  );
}

function SourceLine({
  localCollections,
  libraryCollections,
  fromLibrary,
  libraryError,
}: {
  localCollections: number;
  libraryCollections: number;
  fromLibrary: number;
  libraryError?: string;
}): JSX.Element {
  if (libraryError) {
    return (
      <p style={{ color: "var(--fos-warn)", margin: "8px 0 0" }}>
        Couldn't read enabled libraries: {libraryError}
      </p>
    );
  }

  if (localCollections === 0 && libraryCollections === 0) {
    return (
      <p style={{ color: "var(--fos-warn)", margin: "8px 0 0" }}>
        No local variable collections and no enabled libraries publishing variables.
      </p>
    );
  }

  if (localCollections === 0 && fromLibrary > 0) {
    return (
      <p className="muted" style={{ margin: "8px 0 0" }}>
        Variables come from {libraryCollections}{" "}
        {libraryCollections === 1 ? "library" : "libraries"}. Binding one imports it into this
        file — checking never does.
      </p>
    );
  }

  if (fromLibrary > 0) {
    return (
      <p className="muted" style={{ margin: "8px 0 0" }}>
        {localCollections} local {localCollections === 1 ? "collection" : "collections"} ·{" "}
        {fromLibrary} tokens will import from a library on first bind.
      </p>
    );
  }

  return (
    <p className="muted" style={{ margin: "8px 0 0" }}>
      {localCollections} local {localCollections === 1 ? "collection" : "collections"}
      {libraryCollections > 0
        ? ` · ${libraryCollections} ${libraryCollections === 1 ? "library" : "libraries"} enabled`
        : ""}
      .
    </p>
  );
}
