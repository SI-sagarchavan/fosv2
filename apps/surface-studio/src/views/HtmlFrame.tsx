import { useEffect, useRef, useState } from "react";

/**
 * The widths worth checking. Type tokens are per-breakpoint, so these differ.
 * Same list as the run preview and for the same reason: one desktop is not
 * enough to see a frame pinned to its artboard.
 */
export const WIDTHS = [
  { label: "Mobile", px: 390 },
  { label: "Tablet", px: 768 },
  { label: "Desktop", px: 1280 },
  { label: "Wide", px: 1920 },
] as const;

/**
 * A rendered page, scaled to fit rather than reflowed.
 *
 * `srcDoc` in a sandboxed iframe: the renderer's stylesheet is global, so it
 * must not share a document with the board; and `allow-same-origin` WITHOUT
 * `allow-scripts` lets this read the content height while guaranteeing nothing
 * inside — including a sample payload someone pasted from an API — can run.
 *
 * The iframe keeps its true width and a transform does the fitting, because the
 * emitted media queries key off the VIEWPORT: shrinking the frame would resolve
 * mobile type for a desktop design.
 */
export function HtmlFrame({
  html,
  designWidth,
  busy,
}: {
  html: string;
  designWidth?: number;
  busy?: boolean;
}) {
  const [width, setWidth] = useState<number>(designWidth && designWidth > 0 ? designWidth : 1280);
  const [scale, setScale] = useState(1);
  const [height, setHeight] = useState(500);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const fit = () => setScale(Math.min(1, node.clientWidth / width));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    return () => observer.disconnect();
  }, [width]);

  function measure(event: React.SyntheticEvent<HTMLIFrameElement>): void {
    const doc = event.currentTarget.contentDocument;
    if (doc?.body) setHeight(Math.max(200, doc.documentElement.scrollHeight || doc.body.scrollHeight));
  }

  const widths: Array<{ label: string; px: number }> = [...WIDTHS];
  if (designWidth && !widths.some((w) => w.px === designWidth)) widths.push({ label: "Design", px: designWidth });
  widths.sort((a, b) => a.px - b.px);

  return (
    <div className="preview">
      <div className="preview-bar">
        {widths.map((w) => (
          <button key={w.px} className={w.px === width ? "chip is-on" : "chip"} onClick={() => setWidth(w.px)}>
            {w.label}
          </button>
        ))}
        <span className="preview-note">
          {width}px · {Math.round(scale * 100)}%{busy ? " · updating…" : ""}
        </span>
      </div>
      <div className="preview-box" ref={box} style={{ height: height * scale }}>
        <iframe
          title="rendered page"
          sandbox="allow-same-origin"
          srcDoc={html}
          onLoad={measure}
          style={{ width, height, transform: `scale(${scale})`, transformOrigin: "top left" }}
        />
      </div>
    </div>
  );
}
