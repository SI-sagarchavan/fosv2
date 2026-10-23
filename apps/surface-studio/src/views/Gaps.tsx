import { useMemo, useState } from "react";
import type { Gap, GapCategory, InspectResult } from "../inspect-types.js";
import { href } from "../router.js";

const CATEGORIES: Array<{ id: GapCategory; label: string; asks: string }> = [
  { id: "content", label: "Content", asks: "Did every word from the design make it into the tree?" },
  { id: "coverage", label: "Coverage", asks: "Did everything that paints make it into the tree, at the right box?" },
  { id: "vocabulary", label: "Vocabulary", asks: "Does the DSL have a way to say it at all?" },
  { id: "tokens", label: "Tokens", asks: "Did a value land on a design token, or as a raw number?" },
  { id: "judgment", label: "Judgment calls", asks: "What did the compiler decide on the designer's behalf?" },
  { id: "validity", label: "Validity", asks: "Is the tree legal DSL?" },
  { id: "logic", label: "Logic", asks: "What is frozen that a live page would expect to change?" },
];

export function Gaps({ data, base }: { data: InspectResult; base: string }) {
  const [category, setCategory] = useState<GapCategory | "all">("all");

  const counts = useMemo(() => {
    const c: Partial<Record<GapCategory, number>> = {};
    for (const g of data.gaps) c[g.category] = (c[g.category] ?? 0) + 1;
    return c;
  }, [data.gaps]);

  const shown = data.gaps.filter((g) => category === "all" || g.category === category);
  const errors = data.gaps.filter((g) => g.severity === "error").length;
  const warnings = data.gaps.filter((g) => g.severity === "warning").length;
  const s = data.stats;

  return (
    <div className="gaps">
      <p className="lede">
        What the trip from Figma IR to DSL lost, guessed, or cannot say. Computed by the real compiler, the real
        fidelity gate and the real validator — theme: <code>{data.themeSource}</code>.
      </p>

      <section className="funnel" aria-label="IR to DSL funnel">
        <FunnelStep n={s.irNodes} label="IR layers" />
        <FunnelStep n={s.irPainting} label="put ink on screen" />
        <FunnelStep n={s.coverage.direct} label="drawn as themselves" />
        <FunnelStep n={s.coverage.absorbed + s.coverage.repeated} label="covered by another node" />
        <FunnelStep n={s.coverage.missing} label="missing" bad={s.coverage.missing > 0} />
        <FunnelStep n={s.emitted} label="DSL nodes emitted" last />
      </section>

      <div className="toolbar">
        <div className="seg" role="tablist">
          <button className={category === "all" ? "seg-btn is-on" : "seg-btn"} onClick={() => setCategory("all")}>
            All<span className="seg-count">{data.gaps.length}</span>
          </button>
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              className={category === c.id ? "seg-btn is-on" : "seg-btn"}
              onClick={() => setCategory(c.id)}
              title={c.asks}
              disabled={!counts[c.id]}
            >
              {c.label}
              <span className="seg-count">{counts[c.id] ?? 0}</span>
            </button>
          ))}
        </div>
        <span className="pane-note">
          {errors} error{errors === 1 ? "" : "s"} · {warnings} warning{warnings === 1 ? "" : "s"}
        </span>
      </div>

      {category !== "all" ? <p className="asks">{CATEGORIES.find((c) => c.id === category)?.asks}</p> : null}

      {shown.length === 0 ? (
        <p className="none">{data.gaps.length === 0 ? "No gaps found — the tree says everything the frame says." : "Nothing in this category."}</p>
      ) : (
        <ul className="gap-list">
          {shown.map((g) => (
            <GapCard key={g.id} gap={g} base={base} />
          ))}
        </ul>
      )}
    </div>
  );
}

function FunnelStep({ n, label, bad, last }: { n: number; label: string; bad?: boolean; last?: boolean }) {
  return (
    <div className={`funnel-step${bad ? " is-bad" : ""}${last ? " is-last" : ""}`}>
      <span className="funnel-n">{n.toLocaleString()}</span>
      <span className="funnel-label">{label}</span>
    </div>
  );
}

function GapCard({ gap, base }: { gap: Gap; base: string }) {
  return (
    <li className={`gap is-${gap.severity}`}>
      <header>
        <span className={`sev is-${gap.severity}`}>{gap.severity}</span>
        <span className="cat">{gap.category}</span>
        <h3>{gap.title}</h3>
      </header>
      <p className="gap-detail">{gap.detail}</p>
      {gap.fix ? (
        <p className="gap-fix">
          <b>Fix</b> {gap.fix}
        </p>
      ) : null}
      {gap.irIds.length + gap.dslIds.length > 0 ? (
        <p className="links">
          {gap.irIds.map((id) => (
            <a key={`i${id}`} className="pill" href={href(`${base}/ir`, { node: id })}>
              IR {id}
            </a>
          ))}
          {gap.dslIds.map((id) => (
            <a key={`d${id}`} className="pill" href={href(`${base}/dsl`, { node: id })}>
              DSL {id}
            </a>
          ))}
          {gap.count > gap.irIds.length + gap.dslIds.length ? <span className="more">+ more</span> : null}
        </p>
      ) : null}
    </li>
  );
}
