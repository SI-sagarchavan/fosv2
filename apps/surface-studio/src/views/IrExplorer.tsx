import { useMemo, useState } from "react";
import type { InspectResult, IrRow, IrStatus } from "../inspect-types.js";
import { href } from "../router.js";
import { TreePane } from "./TreeView.js";

const STATUS: Record<IrStatus, { label: string; blurb: string }> = {
  direct: { label: "direct", blurb: "A DSL node names this layer as its `src` — it is drawn as itself." },
  absorbed: {
    label: "absorbed",
    blurb:
      "Something that is in the tree covers it: a leaf swallowing its subtree (a glyph's paths), a surface standing in for a plate, or a Repeater template standing in for N copies.",
  },
  missing: { label: "missing", blurb: "It paints in Figma and nothing in the tree draws it. Conform C1 fails on it." },
  scaffold: { label: "scaffold", blurb: "It puts no ink on screen, so the tree is free to flatten it away." },
};

const ORDER: IrStatus[] = ["direct", "absorbed", "missing", "scaffold"];

export function IrExplorer({
  data,
  base,
  selected,
  onSelect,
}: {
  data: InspectResult;
  /** `/export/<id>` or `/playground` — where the DSL tab lives. */
  base: string;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const [status, setStatus] = useState<IrStatus | "all">("all");
  const [query, setQuery] = useState("");

  const counts = useMemo(() => {
    const c: Record<IrStatus, number> = { direct: 0, absorbed: 0, missing: 0, scaffold: 0 };
    for (const r of data.irRows) c[r.status] += 1;
    return c;
  }, [data.irRows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (status === "all" && !q) return null;
    return new Set(
      data.irRows
        .filter(
          (r) =>
            (status === "all" || r.status === status) &&
            (!q || `${r.name} ${r.text ?? ""} ${r.id} ${r.type}`.toLowerCase().includes(q)),
        )
        .map((r) => r.id),
    );
  }, [data.irRows, status, query]);

  const row = data.irRows.find((r) => r.id === selected) ?? null;

  return (
    <div className="explorer">
      <div className="pane">
        <div className="pane-bar">
          <input
            className="search"
            type="search"
            placeholder="Filter layers…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter IR layers"
          />
          <div className="seg">
            <button className={status === "all" ? "seg-btn is-on" : "seg-btn"} onClick={() => setStatus("all")}>
              All<span className="seg-count">{data.irRows.length}</span>
            </button>
            {ORDER.map((s) => (
              <button key={s} className={status === s ? "seg-btn is-on" : "seg-btn"} onClick={() => setStatus(s)}>
                <i className={`dot is-${s}`} />
                {STATUS[s].label}
                <span className="seg-count">{counts[s]}</span>
              </button>
            ))}
          </div>
        </div>
        <TreePane
          items={data.irRows}
          selected={selected}
          onSelect={onSelect}
          filtered={filtered}
          collapsedAtDepth={5}
          render={(r) => <IrLine row={r} />}
        />
      </div>

      <div className="pane detail">
        {row ? (
          <IrDetail row={row} data={data} base={base} onSelect={onSelect} />
        ) : (
          <p className="detail-empty">
            Pick a layer to see what Figma recorded for it and which DSL node ended up drawing it.
          </p>
        )}
      </div>
    </div>
  );
}

function IrLine({ row }: { row: IrRow }) {
  return (
    <>
      <i className={`dot is-${row.status}`} title={row.status} />
      <span className="tree-type">{row.type.toLowerCase()}</span>
      <span className="tree-name">{row.name}</span>
      {row.text ? <span className="tree-text">“{row.text.replace(/\s+/g, " ").slice(0, 48)}”</span> : null}
    </>
  );
}

function IrDetail({
  row,
  data,
  base,
  onSelect,
}: {
  row: IrRow;
  data: InspectResult;
  base: string;
  onSelect: (id: string) => void;
}) {
  const f = row.facts;
  const parent = row.parent ? data.irRows.find((r) => r.id === row.parent) : null;
  const dsl = row.dsl.map((id) => data.dsl.nodes.find((n) => n.id === id)).filter((n) => n !== undefined);
  const gaps = data.gaps.filter((g) => g.irIds.includes(row.id));

  return (
    <div>
      <h3 className="detail-title">{row.name}</h3>
      <p className="detail-sub">
        {row.type} · <code>{row.id}</code>
        {parent ? (
          <>
            {" "}
            · in{" "}
            <button className="linkish" onClick={() => onSelect(parent.id)}>
              {parent.name}
            </button>
          </>
        ) : null}
      </p>

      <div className={`verdict is-${row.status}`}>
        <b>{STATUS[row.status].label}</b>
        <span>{STATUS[row.status].blurb}</span>
      </div>

      {dsl.length > 0 ? (
        <p className="links">
          {row.status === "direct" ? "Drawn by" : "Covered by"}{" "}
          {dsl.map((n) => (
            <a key={n.id} className="pill" href={href(`${base}/dsl`, { node: n.id })}>
              {n.type} · {n.id}
            </a>
          ))}
        </p>
      ) : null}

      {gaps.length > 0 ? (
        <ul className="detail-gaps">
          {gaps.map((g) => (
            <li key={g.id} className={`is-${g.severity}`}>
              <b>{g.category}</b> {g.title}
            </li>
          ))}
        </ul>
      ) : null}

      {row.text ? <blockquote className="quote">{row.text}</blockquote> : null}

      <dl className="facts">
        <Fact k="box" v={`${row.box.w}×${row.box.h} at ${row.box.x},${row.box.y}`} />
        <Fact k="layout" v={`${f.layout} · ${f.sizing}`} />
        <Fact k="gap" v={f.gap} />
        <Fact k="padding" v={f.padding} />
        <Fact k="fill" v={f.fill} />
        <Fact k="stroke" v={f.stroke} />
        <Fact k="radius" v={f.radius} />
        <Fact k="font" v={f.font} />
        <Fact k="text case" v={f.textCase} />
        <Fact k="truncation" v={f.truncation} />
        <Fact k="effects" v={f.effects > 0 ? String(f.effects) : undefined} />
        <Fact k="opacity" v={f.opacity < 1 ? String(f.opacity) : undefined} />
        <Fact k="rotation" v={Math.abs(f.rotation) > 0.5 ? `${Math.round(f.rotation)}°` : undefined} />
        <Fact k="clips" v={f.clips ? "yes" : undefined} />
        <Fact k="component" v={f.componentKey} />
        <Fact k="background" v={f.background} />
        <Fact k="repeated ×" v={f.repeatedSiblings > 1 ? String(f.repeatedSiblings) : undefined} />
      </dl>

      {f.unbound.length > 0 ? (
        <p className="unbound">
          <b>No variable behind:</b> {f.unbound.join(" · ")}
        </p>
      ) : null}
    </div>
  );
}

function Fact({ k, v }: { k: string; v: string | undefined }) {
  if (!v) return null;
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}
