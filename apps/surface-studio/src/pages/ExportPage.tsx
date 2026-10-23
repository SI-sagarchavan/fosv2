import { stageOf, useBoard } from "../board.js";
import type { Source } from "../api.js";
import { Compile } from "../components/compile.js";
import { pct, titleOf, when } from "../format.js";
import type { ExportRow, PlateRow } from "../types.js";
import { Inspector, type Tab } from "./Inspector.js";

const TABS: Tab[] = ["overview", "render", "ir", "dsl", "gaps", "data"];

export function ExportPage({ id, tab, node }: { id: string; tab: string | undefined; node: string | null }) {
  const { loading, byId, platesFor } = useBoard();
  const row = byId(id);

  if (!row) {
    return (
      <p className="none">
        {loading ? "Loading…" : "That export is not on the board — it may have been deleted, or belongs to another project."}{" "}
        <a href="#/">Back to the board</a>
      </p>
    );
  }

  const active: Tab = (TABS as string[]).includes(tab ?? "") ? (tab as Tab) : "overview";
  const source: Source = { kind: "export", irArtifact: row.ir_artifact_id, key: `export:${row.ir_artifact_id}` };

  return (
    <Inspector
      title={titleOf(row)}
      sub={`${row.file_name} · ${row.page_name} · ${when(row.received_at)}`}
      base={`/export/${row.id}`}
      tabs={TABS}
      tab={active}
      node={node}
      source={source}
      overview={<Overview row={row} plates={platesFor(row.id)} />}
      aside={
        <p className={`badge is-${stageOf(row)}`}>{stageOf(row) === "new" ? "awaiting compile" : stageOf(row)}</p>
      }
    />
  );
}

function Overview({ row, plates }: { row: ExportRow; plates: PlateRow[] }) {
  return (
    <article className="plate">
      <header className="plate-head">
        <div>
          <h2>{titleOf(row)}</h2>
          <p className="plate-sub">
            {row.file_name} · {row.page_name}
          </p>
        </div>
        <p className="score">
          <span>{`${pct(row.coverage_percent)}%`}</span>
          <span className="score-label">bound</span>
        </p>
      </header>

      <p className="plate-stats">
        {Number(row.node_count).toLocaleString()} layers
        <span> · </span>
        {plates.length} {plates.length === 1 ? "plate" : "plates"}
        <span> · </span>
        {when(row.received_at)}
        {row.exported_by ? (
          <>
            <span> · </span>
            {row.exported_by}
          </>
        ) : null}
      </p>

      {plates.length > 0 ? (
        <div className="shots">
          {plates.map((plate) => (
            <figure key={plate.id}>
              {/* Immutable blob, fetched once and cached — not re-sent with
                  every board update the way inline base64 was. */}
              <img src={`/v1/blobs/${plate.artifact_id}`} alt={plate.name} />
              <figcaption>{plate.name.replace(/-\d+-\d+(?=\.png$)/, "")}</figcaption>
            </figure>
          ))}
        </div>
      ) : null}

      <Compile row={row} />
    </article>
  );
}
