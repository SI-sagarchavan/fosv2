import { useEffect, useMemo, useState } from "react";
import { fetchDataset, fetchDatasets, useBindings, type Source } from "../api.js";
import { download } from "../format.js";
import type {
  InspectResult,
  PlanBindingWire,
  PlanCollapseWire,
  PlanWire,
  ShapePath,
  Suggestion,
} from "../inspect-types.js";
import { href } from "../router.js";
import { HtmlFrame } from "./HtmlFrame.js";

const EMPTY_PLAN: PlanWire = {};

/** localStorage, never required: a blocked store just means nothing is remembered. */
function recall(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function remember(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

const sameBind = (a: PlanBindingWire, b: PlanBindingWire): boolean => a.src === b.src && a.prop === b.prop;
const sameCollapse = (a: PlanCollapseWire, b: PlanCollapseWire): boolean =>
  a.members.join() === b.members.join();

function accepted(plan: PlanWire, s: Suggestion): boolean {
  if (s.kind === "bind") return (plan.bind ?? []).some((b) => sameBind(b, s.entry as PlanBindingWire) && b.path === (s.entry as PlanBindingWire).path);
  return (plan.collapse ?? []).some((c) => sameCollapse(c, s.entry as PlanCollapseWire));
}

function withSuggestion(plan: PlanWire, s: Suggestion): PlanWire {
  if (s.kind === "bind") {
    const entry = s.entry as PlanBindingWire;
    return { ...plan, bind: [...(plan.bind ?? []).filter((b) => !sameBind(b, entry)), entry] };
  }
  const entry = s.entry as PlanCollapseWire;
  return { ...plan, collapse: [...(plan.collapse ?? []).filter((c) => !sameCollapse(c, entry)), entry] };
}

export function DataLogic({ source, inspection, base }: { source: Source; inspection: InspectResult; base: string }) {
  const storeKey = `studio.data.${source.key}`;
  const [text, setText] = useState<string>(() => recall(`${storeKey}.sample`) ?? "");
  const [plan, setPlan] = useState<PlanWire>(() => {
    const saved = recall(`${storeKey}.plan`);
    try {
      return saved ? (JSON.parse(saved) as PlanWire) : EMPTY_PLAN;
    } catch {
      return EMPTY_PLAN;
    }
  });
  const [datasets, setDatasets] = useState<string[] | null>(null);
  const [url, setUrl] = useState("");
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    remember(`${storeKey}.sample`, text || null);
  }, [storeKey, text]);
  useEffect(() => {
    remember(`${storeKey}.plan`, plan.bind?.length || plan.collapse?.length ? JSON.stringify(plan) : null);
  }, [storeKey, plan]);
  useEffect(() => {
    fetchDatasets()
      .then((d) => setDatasets(d.datasets))
      .catch(() => setDatasets([]));
  }, []);

  const parsed = useMemo((): { data?: Record<string, unknown>; error?: string } => {
    if (!text.trim()) return {};
    try {
      const value: unknown = JSON.parse(text);
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return { error: "the sample must be a JSON object — its keys are the paths a tree binds to" };
      }
      return { data: value as Record<string, unknown> };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }, [text]);

  const result = useBindings(source, { data: parsed.data, plan }, true);
  const analysis = result.state === "ready" || (result.state === "loading" && result.data) || (result.state === "error" && result.data) ? result.data : undefined;

  async function load(name: string): Promise<void> {
    setNote(null);
    try {
      setText(JSON.stringify(await fetchDataset(name), null, 2));
      setNote(`Loaded dataset “${name}”.`);
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    }
  }

  async function fetchUrl(): Promise<void> {
    setNote(null);
    try {
      // From the BROWSER, deliberately: a server-side fetch of an arbitrary URL
      // is an open proxy. The cost is CORS — an API that does not allow this
      // origin has to be pasted instead, and the message says so.
      const response = await fetch(url, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const body: unknown = await response.json();
      setText(JSON.stringify(Array.isArray(body) ? { items: body } : body, null, 2));
      setNote(`Fetched ${new URL(url).host}${Array.isArray(body) ? " — the response was a bare array, so it is under “items”." : "."}`);
    } catch (err) {
      setNote(`${err instanceof Error ? err.message : String(err)} — if this is a CORS refusal, paste the response instead.`);
    }
  }

  const suggestions = analysis?.suggestions ?? [];
  const open = suggestions.filter((s) => !accepted(plan, s));
  const planSize = (plan.bind?.length ?? 0) + (plan.collapse?.length ?? 0);

  return (
    <div className="data">
      <p className="lede">
        Today the tree reads data one way: <code>{"{path}"}</code> in a string prop, and a <code>Repeater</code>{" "}
        over a list. The compiler never binds — it keeps the mock-up's copy — so this page does the binding
        step: give it a sample of the API response and it proposes which text, images and repeating cards map to
        which fields, shows what the response offers that nothing reads yet, and renders the result.
      </p>

      <div className="data-grid">
        <section className="panel">
          <h3>Sample response</h3>
          <textarea
            className="code"
            spellCheck={false}
            value={text}
            placeholder={'{\n  "news": {\n    "eyebrow": "…",\n    "items": [ { "headline": "…" } ]\n  }\n}'}
            onChange={(e) => setText(e.target.value)}
            aria-label="Sample JSON response"
          />
          {parsed.error ? <p className="compile-error">{parsed.error}</p> : null}
          <div className="row">
            <select
              className="select"
              value=""
              onChange={(e) => e.target.value && void load(e.target.value)}
              disabled={!datasets || datasets.length === 0}
              aria-label="Load a named dataset"
            >
              <option value="">{datasets && datasets.length === 0 ? "No named datasets" : "Load named dataset…"}</option>
              {(datasets ?? []).map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <button className="chip" onClick={() => setText("")} disabled={!text}>
              Clear
            </button>
          </div>
          <div className="row">
            <input className="search" type="url" placeholder="https://api.example.com/v1/news" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="API URL" />
            <button className="chip" onClick={() => void fetchUrl()} disabled={!url}>
              Fetch
            </button>
          </div>
          {note ? <p className="note">{note}</p> : null}
        </section>

        <section className="panel">
          <h3>
            Rendered with the plan{" "}
            {analysis?.applied ? (
              <span className="pane-note">
                {analysis.applied.bound} bound · {analysis.applied.collapsed} repeater{analysis.applied.collapsed === 1 ? "" : "s"}
              </span>
            ) : null}
          </h3>
          {result.state === "error" ? <p className="compile-error">{result.message}</p> : null}
          {analysis?.html ? (
            <HtmlFrame html={analysis.html} designWidth={analysis.width ?? inspection.doc.width} busy={result.state === "loading"} />
          ) : (
            <p className="none">{result.state === "loading" ? "Rendering…" : "Add a sample response to bind against."}</p>
          )}
        </section>
      </div>

      <section className="panel">
        <header className="panel-head">
          <h3>Suggested bindings</h3>
          <span className="pane-note">{open.length} open · {suggestions.length - open.length} accepted</span>
          <button
            className="chip"
            disabled={open.length === 0}
            onClick={() => setPlan(open.reduce<PlanWire>((p, s) => withSuggestion(p, s), plan))}
          >
            Accept all
          </button>
        </header>
        {!parsed.data ? (
          <p className="none">Suggestions need a sample response.</p>
        ) : suggestions.length === 0 ? (
          <p className="none">
            Nothing in the tree reads like anything in this response. The copy in the design may differ from the
            sample — in which case bind by writing the plan below.
          </p>
        ) : (
          <ul className="suggest">
            {suggestions.map((s, i) => {
              const done = accepted(plan, s);
              return (
                <li key={i} className={done ? "is-done" : undefined}>
                  <span className={`basis is-${s.basis}`} title={BASIS[s.basis]}>
                    {s.kind === "collapse" ? "repeat" : "bind"} · {s.basis}
                  </span>
                  <span className="suggest-text">{s.summary}</span>
                  <button className="chip" disabled={done} onClick={() => setPlan(withSuggestion(plan, s))}>
                    {done ? "Accepted" : "Accept"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="data-grid">
        <section className="panel">
          <header className="panel-head">
            <h3>Binding plan</h3>
            <span className="pane-note">{planSize} entr{planSize === 1 ? "y" : "ies"}</span>
            <button className="chip" onClick={() => download("binding-plan.json", JSON.stringify(plan, null, 2))} disabled={planSize === 0}>
              Download
            </button>
            <button className="chip" onClick={() => setPlan(EMPTY_PLAN)} disabled={planSize === 0}>
              Reset
            </button>
          </header>
          <PlanEditor plan={plan} onChange={setPlan} />
          {analysis?.applied?.drift.length ? (
            <ul className="drift">
              {analysis.applied.drift.map((d, i) => (
                <li key={i}>
                  <b>{d.reason}</b> {d.message}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="note">
            Keyed by the Figma node id, not the DSL id — layer renames and reordering do not move it. This is the
            existing <code>binding_plan</code> artifact format; download it and upload it to the project to make
            runs render with it.
          </p>
        </section>

        <section className="panel">
          <h3>API fields nothing reads</h3>
          {!parsed.data ? (
            <p className="none">Needs a sample response.</p>
          ) : (analysis?.unused.length ?? 0) === 0 ? (
            <p className="none">Every scalar in the response is read by the tree.</p>
          ) : (
            <>
              <p className="note">
                These are the fields the design has no element for. When an API adds a field after launch, this is
                where it shows up.
              </p>
              <ul className="unused">
                {(analysis?.shape ?? [])
                  .filter((s) => s.hint)
                  .map((s) => (
                    <li key={s.path}>
                      <code>{s.path}</code>
                      <span className="unused-sample">{s.sample}</span>
                      <span className="hint">{HINT[s.hint as NonNullable<ShapePath["hint"]>]}</span>
                    </li>
                  ))}
              </ul>
            </>
          )}
        </section>
      </div>

      <div className="data-grid">
        <section className="panel">
          <h3>What the tree reads now</h3>
          {(analysis?.refs.length ?? 0) === 0 && (analysis?.repeaters.length ?? 0) === 0 ? (
            <p className="none">Nothing yet — every prop is a literal.</p>
          ) : (
            <>
              {analysis?.repeaters.map((r) => (
                <p key={r.nodeId} className="repeater">
                  <a className="pill" href={href(`${base}/dsl`, { node: r.nodeId })}>Repeater {r.nodeId}</a> over <code>{r.over}</code> as <code>{r.as}</code>
                  {r.slice ? ` [${r.slice[0]}..${r.slice[1]}]` : r.limit ? ` first ${r.limit}` : ""}
                  {r.items !== null ? ` — ${r.items} item${r.items === 1 ? "" : "s"} in the sample` : ""}
                </p>
              ))}
              <table className="refs">
                <tbody>
                  {analysis?.refs.map((r, i) => (
                    <tr key={i} className={r.resolved === false ? "is-bad" : undefined}>
                      <td>
                        <a className="pill" href={href(`${base}/dsl`, { node: r.nodeId })}>{r.nodeId}</a>.{r.prop}
                      </td>
                      <td>
                        <code>{`{${r.path}}`}</code>
                      </td>
                      <td>{r.resolved === null ? "" : r.resolved ? r.sample ?? "✓" : "unresolved"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>

        <section className="panel">
          <h3>Repeating groups in the design</h3>
          {(analysis?.proposals.length ?? 0) === 0 ? (
            <p className="none">No run of sibling subtrees with the same shape. A list of one is not detected.</p>
          ) : (
            <ul className="proposals">
              {analysis?.proposals.map((p) => (
                <li key={p.templateId}>
                  <b>{p.count} × <a className="pill" href={href(`${base}/dsl`, { node: p.templateId })}>{p.templateId}</a></b> in {p.parentId}
                  <span className="pane-note"> · collapsing saves {p.nodesSaved} nodes</span>
                  {p.varying.length === 0 ? (
                    <p className="note">Every instance carries the same copy, so field names cannot be inferred from the design — only from a sample response.</p>
                  ) : (
                    <ul>
                      {p.varying.map((v, i) => (
                        <li key={i}>
                          <code>{v.nodeId}.{v.prop}</code> varies: {v.values.map((x) => `“${x}”`).join(", ")}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="note">
            Only runs of identical siblings are found. An index-tiered grid (a lead, two features, three briefs from
            one list) shows up as separate groups — or not at all when the tiers differ in shape.
          </p>
        </section>
      </div>
    </div>
  );
}

const BASIS: Record<Suggestion["basis"], string> = {
  exact: "the design's copy equals exactly one value in the sample",
  aligned: "every instance's copy equals the same field of consecutive items, in order",
  ambiguous: "more than one candidate, or no field matched — check before accepting",
};

const HINT: Record<NonNullable<ShapePath["hint"]>, string> = {
  Text: "→ Text",
  Image: "→ Image",
  Link: "→ Link / Button href",
  date: "→ Text, needs a date format (none yet)",
  when: "→ show/hide (`when` is not evaluated yet)",
};

/** The plan as editable JSON, with the shape checked before it is believed. */
function PlanEditor({ plan, onChange }: { plan: PlanWire; onChange: (p: PlanWire) => void }) {
  const json = useMemo(() => JSON.stringify(plan, null, 2), [plan]);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <textarea
        className="code is-short"
        spellCheck={false}
        value={draft ?? json}
        onChange={(e) => {
          setDraft(e.target.value);
          try {
            const next = JSON.parse(e.target.value) as PlanWire;
            if (next === null || typeof next !== "object" || Array.isArray(next)) throw new Error("a plan is an object");
            setError(null);
            onChange(next);
          } catch (err) {
            setError((err as Error).message);
          }
        }}
        onBlur={() => {
          if (!error) setDraft(null);
        }}
        aria-label="Binding plan JSON"
      />
      {error ? <p className="compile-error">{error}</p> : null}
    </>
  );
}
