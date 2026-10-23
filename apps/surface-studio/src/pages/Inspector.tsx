import type { ReactNode } from "react";
import { useInspect, type Source } from "../api.js";
import type { InspectResult } from "../inspect-types.js";
import { go, href } from "../router.js";
import { DataLogic } from "../views/DataLogic.js";
import { DslExplorer } from "../views/DslExplorer.js";
import { Gaps } from "../views/Gaps.js";
import { HtmlFrame } from "../views/HtmlFrame.js";
import { IrExplorer } from "../views/IrExplorer.js";

export type Tab = "overview" | "render" | "ir" | "dsl" | "gaps" | "data";

const LABEL: Record<Tab, string> = {
  overview: "Overview",
  render: "Render",
  ir: "IR",
  dsl: "DSL",
  gaps: "Gaps",
  data: "Data & logic",
};

/**
 * The same four views over any IR — an export from the board, or a file dropped
 * into the Playground. They differ only in where the document comes from, so
 * they share this shell rather than growing two.
 */
export function Inspector({
  title,
  sub,
  base,
  tabs,
  tab,
  node,
  source,
  overview,
  aside,
}: {
  title: string;
  sub: string;
  /** `/export/<id>` or `/playground`. */
  base: string;
  tabs: Tab[];
  tab: Tab;
  node: string | null;
  source: Source;
  overview?: ReactNode;
  aside?: ReactNode;
}) {
  // The overview is the cheap tab: it must not trigger a compile.
  const inspection = useInspect(tab === "overview" ? null : source);
  const data = inspection.state === "ready" ? inspection.data : inspection.state === "loading" || inspection.state === "error" ? inspection.data : undefined;

  const select = (id: string) => go(`${base}/${tab}`, { node: id });

  return (
    <div className="inspector">
      <header className="ins-head">
        <div>
          <p className="eyebrow">
            <a href="#/">Board</a> / {base.startsWith("/export") ? "Export" : "Playground"}
          </p>
          <h2>{title}</h2>
          <p className="ins-sub">{sub}</p>
        </div>
        {aside}
      </header>

      <nav className="tabs" aria-label="Views">
        {tabs.map((t) => (
          <a key={t} href={href(`${base}/${t}`)} className={t === tab ? "tab is-on" : "tab"} aria-current={t === tab ? "page" : undefined}>
            {LABEL[t]}
            {t === "gaps" && data ? <GapBadge data={data} /> : null}
          </a>
        ))}
        {tab !== "overview" ? (
          <button className="chip tabs-end" onClick={inspection.reload} disabled={inspection.state === "loading"}>
            {inspection.state === "loading" ? "Compiling…" : "Recompile"}
          </button>
        ) : null}
      </nav>

      {tab === "overview" ? (
        overview
      ) : inspection.state === "error" && !data ? (
        <div className="fail">
          <p className="compile-error">{inspection.message}</p>
          <p className="note">
            A compile failure is an answer: the message names the layer or token it could not read. Fix it in Figma
            or the theme, send again, then recompile.
          </p>
        </div>
      ) : !data ? (
        <p className="none">Compiling the IR and checking it against the design…</p>
      ) : (
        <>
          {inspection.state === "error" ? <p className="compile-error">{inspection.message}</p> : null}
          {tab === "render" ? (
            data.html ? (
              <HtmlFrame html={data.html} designWidth={data.width ?? data.doc.width} busy={inspection.state === "loading"} />
            ) : (
              <p className="none">No render.</p>
            )
          ) : null}
          {tab === "ir" ? <IrExplorer data={data} base={base} selected={node} onSelect={select} /> : null}
          {tab === "dsl" ? <DslExplorer data={data} base={base} selected={node} onSelect={select} /> : null}
          {tab === "gaps" ? <Gaps data={data} base={base} /> : null}
          {tab === "data" ? <DataLogic source={source} inspection={data} base={base} /> : null}
        </>
      )}
    </div>
  );
}

function GapBadge({ data }: { data: InspectResult }) {
  const errors = data.gaps.filter((g) => g.severity === "error").length;
  if (data.gaps.length === 0) return <span className="tab-badge is-ok">0</span>;
  return <span className={errors > 0 ? "tab-badge is-error" : "tab-badge"}>{errors > 0 ? errors : data.gaps.length}</span>;
}
