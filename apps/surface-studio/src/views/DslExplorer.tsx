import { useMemo, useState } from "react";
import { download } from "../format.js";
import type { DslNode, InspectIssue, InspectResult, Json } from "../inspect-types.js";
import { href } from "../router.js";
import { TreePane, type TreeItem } from "./TreeView.js";

export interface DslItem extends TreeItem {
  node: DslNode;
}

/** The flat wire list -> pre-order with depth, children by `idx`. */
export function preorder(nodes: readonly DslNode[]): DslItem[] {
  const kids = new Map<string | null, DslNode[]>();
  for (const n of nodes) {
    const list = kids.get(n.parent) ?? [];
    list.push(n);
    kids.set(n.parent, list);
  }
  for (const list of kids.values()) list.sort((a, b) => a.idx - b.idx);

  const out: DslItem[] = [];
  const visit = (n: DslNode, depth: number): void => {
    out.push({ id: n.id, parent: n.parent, depth, node: n });
    for (const c of kids.get(n.id) ?? []) visit(c, depth + 1);
  };
  for (const root of kids.get(null) ?? []) visit(root, 0);
  return out;
}

const BIND_RE = /\{[A-Za-z_][A-Za-z0-9_.]*\}/;

export function isBound(node: DslNode): boolean {
  return Object.entries(node.props).some(([k, v]) => k !== "_meta" && JSON.stringify(v).match(BIND_RE) !== null);
}

/** The words or ref a node shows, for the row. */
function gist(n: DslNode): string {
  for (const key of ["content", "label", "src", "name", "over"]) {
    const v = n.props[key];
    if (typeof v === "string" && v) return v.replace(/\s+/g, " ").slice(0, 52);
  }
  return "";
}

export function DslExplorer({
  data,
  tree,
  base,
  selected,
  onSelect,
  issues,
}: {
  data: InspectResult;
  /** Defaults to the compiled tree; the Data page passes the bound one. */
  tree?: InspectResult["dsl"];
  base: string;
  selected: string | null;
  onSelect: (id: string) => void;
  issues?: InspectIssue[];
}) {
  const dsl = tree ?? data.dsl;
  const items = useMemo(() => preorder(dsl.nodes), [dsl]);
  const [query, setQuery] = useState("");
  const [raw, setRaw] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return new Set(items.filter((i) => `${i.node.id} ${i.node.type} ${i.node.src} ${gist(i.node)}`.toLowerCase().includes(q)).map((i) => i.id));
  }, [items, query]);

  const byType = data.stats.byType;
  const item = items.find((i) => i.id === selected) ?? null;
  const all = issues ?? data.validation.concat(data.conform);

  return (
    <div className="explorer">
      <div className="pane">
        <div className="pane-bar">
          <input
            className="search"
            type="search"
            placeholder="Filter nodes…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter DSL nodes"
          />
          <span className="pane-note">
            {dsl.nodes.length} nodes · {Object.entries(byType).map(([t, n]) => `${t} ${n}`).join(" · ")}
          </span>
          <button className="chip" onClick={() => setRaw((r) => !r)}>
            {raw ? "Tree" : "JSON"}
          </button>
          <button className="chip" onClick={() => download(`${data.doc.rootNodeId.replace(/[^\w-]+/g, "_")}.dsl.json`, JSON.stringify(dsl, null, 2))}>
            Download
          </button>
        </div>
        {raw ? (
          <pre className="json">{JSON.stringify(dsl, null, 2)}</pre>
        ) : (
          <TreePane
            items={items}
            selected={selected}
            onSelect={onSelect}
            filtered={filtered}
            collapsedAtDepth={6}
            render={(i) => (
              <>
                <span className={`tree-type t-${i.node.type.toLowerCase()}`}>{i.node.type}</span>
                <span className="tree-name">{i.node.id}</span>
                {isBound(i.node) ? <span className="bound" title="reads data">{"{ }"}</span> : null}
                {gist(i.node) ? <span className="tree-text">{gist(i.node)}</span> : null}
              </>
            )}
          />
        )}
      </div>

      <div className="pane detail">
        {item ? (
          <DslDetail node={item.node} children={items.filter((i) => i.parent === item.id).length} base={base} issues={all.filter((i) => i.nodeId === item.id)} />
        ) : (
          <p className="detail-empty">Pick a node to read its props, the Figma layer it came from, and any finding against it.</p>
        )}
      </div>
    </div>
  );
}

function DslDetail({
  node,
  children,
  base,
  issues,
}: {
  node: DslNode;
  children: number;
  base: string;
  issues: InspectIssue[];
}) {
  const props = Object.entries(node.props).filter(([k]) => k !== "_meta");
  const meta = node.props._meta as { [k: string]: Json } | undefined;

  return (
    <div>
      <h3 className="detail-title">
        {node.type} <span className="detail-id">{node.id}</span>
      </h3>
      <p className="detail-sub">
        {children} child{children === 1 ? "" : "ren"} · from Figma{" "}
        {node.src.startsWith("synthetic:") ? (
          <code>{node.src}</code>
        ) : (
          <a className="pill" href={href(`${base}/ir`, { node: node.src })}>
            {node.src}
          </a>
        )}
      </p>

      {issues.length > 0 ? (
        <ul className="detail-gaps">
          {issues.map((i, k) => (
            <li key={k} className={`is-${i.severity}`}>
              <b>{i.code}</b> {i.message}
              {i.waived ? <em> — waived: {i.waived}</em> : null}
            </li>
          ))}
        </ul>
      ) : null}

      <dl className="facts props">
        {props.map(([k, v]) => (
          <div key={k} className="prop">
            <dt>{k}</dt>
            <dd>
              <PropValue value={v} />
            </dd>
          </div>
        ))}
      </dl>

      {meta ? (
        <details className="meta">
          <summary>_meta</summary>
          <pre className="json">{JSON.stringify(meta, null, 2)}</pre>
        </details>
      ) : null}
    </div>
  );
}

function PropValue({ value }: { value: Json }) {
  if (typeof value === "string") {
    return BIND_RE.test(value) ? <span className="bound-text">{value}</span> : <span>{value}</span>;
  }
  if (typeof value === "number" || typeof value === "boolean") return <span>{String(value)}</span>;
  return <code className="inline-json">{JSON.stringify(value)}</code>;
}
