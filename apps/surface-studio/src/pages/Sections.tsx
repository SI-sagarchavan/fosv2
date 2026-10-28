import { useEffect, useState } from "react";
import { href } from "../router.js";
import { HtmlFrame } from "../views/HtmlFrame.js";

type WidgetId = "news" | "video" | "photos";

interface Widget {
  id: WidgetId;
  label: string;
  count: number;
}

interface Item {
  title: string;
  kind: WidgetId | "other";
  label: string | null;
  published: string | null;
  url: string | null;
}

interface Detail {
  name: string;
  title: string;
  href: string;
  total: number;
  widgets: Widget[];
  items: Item[];
}

interface Listed {
  name: string;
  title: string;
  href: string;
}

/**
 * The first product surface: one section, a news listing.
 *
 * News, video and photos are the three widgets inside it. They are counted
 * from the saved CMS response. The page below is that section, rendered.
 */
export function Sections({ name }: { name?: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [choices, setChoices] = useState<Listed[] | null>(null);
  const [widget, setWidget] = useState<WidgetId | "all">("all");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setDetail(null);
    setHtml(null);
    setChoices(null);
    setWidget("all");

    /** The one section on disk, or null when the page should list them instead. */
    async function soleSection(): Promise<string | null> {
      const response = await fetch("/v1/sections");
      if (!response.ok) throw new Error("The section list did not answer.");
      const body = (await response.json()) as { sections?: Listed[] };
      const sections = body.sections ?? [];
      if (sections.length === 1) return sections[0]!.name;
      if (!cancelled) setChoices(sections);
      return null;
    }

    (async () => {
      const target = name ?? (await soleSection());
      if (cancelled) return;
      if (target === null) return;

      const [summaryRes, pageRes] = await Promise.all([
        fetch(`/v1/sections/${encodeURIComponent(target)}/summary`),
        fetch(`/v1/sections/${encodeURIComponent(target)}`),
      ]);
      if (cancelled) return;
      if (!summaryRes.ok) {
        setError(await failure(summaryRes, `No section named ${target}.`));
        return;
      }
      if (!pageRes.ok) {
        setError(await failure(pageRes, "The section did not render."));
        return;
      }
      setDetail((await summaryRes.json()) as Detail);
      setHtml(await pageRes.text());
    })().catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    });

    return () => {
      cancelled = true;
    };
  }, [name]);

  if (error) {
    return (
      <section className="empty">
        <h2 className="empty-title">This section did not load</h2>
        <p>{error}</p>
      </section>
    );
  }

  if (choices && choices.length === 0) {
    return (
      <section className="empty">
        <h2 className="empty-title">No sections yet</h2>
        <p>A section is a listing on the surface. News is the first one, and it is not on disk.</p>
      </section>
    );
  }

  if (choices && choices.length > 1 && !name) {
    return (
      <section>
        <h2>Sections</h2>
        <p className="lede">Pick a listing. News is the one that carries stories, videos and photos.</p>
        <ul className="section-list">
          {choices.map((section) => (
            <li key={section.name}>
              <a href={href(`/sections/${section.name}`)}>{section.title}</a>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  if (!detail || html === null) return <p className="none">Loading the news section…</p>;

  const shown = widget === "all" ? detail.items : detail.items.filter((item) => item.kind === widget);
  const active = detail.widgets.find((entry) => entry.id === widget);

  return (
    <section className="news-section">
      <h2>{detail.title}</h2>
      <p className="lede">
        The first section on this surface. One listing, made of news, video and photos from the club CMS.
        {detail.total > detail.items.length ? ` ${detail.total.toLocaleString()} stories exist; this page has the first ${detail.items.length}.` : ""}
      </p>

      <div className="stats" role="group" aria-label="Widgets in this section">
        <WidgetStat label="Whole listing" value={String(detail.items.length)} note="on this page" on={widget === "all"} onSelect={() => setWidget("all")} />
        {detail.widgets.map((entry) => (
          <WidgetStat
            key={entry.id}
            label={entry.label}
            value={String(entry.count)}
            note={entry.count === 0 ? "none in this response" : "in this response"}
            on={widget === entry.id}
            onSelect={() => setWidget(entry.id)}
          />
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="none">
          {active
            ? `No ${active.label.toLowerCase()} in this response. The listing still knows the widget; this club feed did not send any.`
            : "Nothing in this listing."}
        </p>
      ) : (
        <ul className="section-items">
          {shown.map((item) => (
            <li key={`${item.kind}-${item.title}-${item.published ?? ""}`}>
              <p className="section-kind">{item.label ?? item.kind}</p>
              {item.url ? (
                <a href={item.url} target="_blank" rel="noreferrer">
                  {item.title}
                </a>
              ) : (
                <span>{item.title}</span>
              )}
              {item.published ? <time dateTime={item.published}>{published(item.published)}</time> : null}
            </li>
          ))}
        </ul>
      )}

      <div className="plate">
        <div className="plate-head">
          <div>
            <h2>On the surface</h2>
            <p className="plate-sub">Rendered from the section on disk. Width changes the breakpoint, not the data.</p>
          </div>
          <a className="preview-open" href={detail.href} target="_blank" rel="noreferrer">
            Open the page
          </a>
        </div>
        <HtmlFrame html={html} />
      </div>
    </section>
  );
}

function WidgetStat({
  label,
  value,
  note,
  on,
  onSelect,
}: {
  label: string;
  value: string;
  note?: string;
  on: boolean;
  onSelect: () => void;
}) {
  return (
    <button type="button" className={on ? "stat is-on" : "stat"} aria-pressed={on} onClick={onSelect}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
      {note ? <span className="stat-note">{note}</span> : null}
    </button>
  );
}

async function failure(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string };
    return body.message || fallback;
  } catch {
    return fallback;
  }
}

function published(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
