/**
 * Index for the render harness.
 *
 * Every frame is listed twice on purpose. The hand-authored tree and the one
 * `@fanos/compile` derives from the same IR are the two ends of the pipeline,
 * and the gap between them is the spec for the semantic pass: bindings,
 * Repeaters, icon names and image sources — none of which are in the IR.
 */

const CARDS = [
  // No hand-authored tree, deliberately: nobody wrote one. That is the example's
  // whole argument, so the cell says so rather than linking to a 404.
  { key: "newsSection", label: "SOUTH COAST STORIES", geom: "1170×444", ir: "1:4745", width: 1170, hand: false, repaired: true, note: "hybrid pipeline — compile + repair + gates" },
  { key: "ticketsHero", label: "THE BOWL IS CALLING", geom: "1366×488", ir: "1:4367", width: 1366, hand: false, repaired: true, note: "hybrid — wordmark + plate collapsed to assets" },
  { key: "photosPage", label: "PHOTOS (full page)", geom: "1366×2488", ir: "88:5758", width: 1366, hand: false, repaired: true, note: "304 IR nodes — hero, 10-card grid, footers" },
  { key: "newsPage", label: "NEWS (full page)", geom: "1366×1643", ir: "147:8742", width: 1366, hand: false, repaired: true, note: "same shared gallery rules as PHOTOS, unmodified" },
  { key: "mobileMenu", label: "M_menu (mobile drawer)", geom: "375×667", ir: "154:9717", width: 375, hand: false, repaired: true, note: "mobile breakpoint — mobile type set, not scaled desktop" },
  { key: "player", label: "player card", geom: "281×412", ir: "1:5043", width: undefined, note: "fixed-aspect, designWidth scaled" },
  { key: "news", label: "news card", geom: "379×380", ir: "1:4920", width: undefined, note: "flow component" },
  { key: "videos", label: "Brave Corner", geom: "1366×512", ir: "1:5124", width: 1366, note: "Repeater ×4 (hand only)" },
  { key: "fixtures", label: "fixture cards", geom: "594×227", ir: "1:5060", width: 594, note: "Repeater ×2 (hand only)" },
  { key: "newsletter", label: "newsletter band", geom: "1366×190", ir: "1:5093", width: 1366, note: "reflows — try other widths" },
] as const;

const link: React.CSSProperties = {
  color: "#7dd3fc",
  fontFamily: "ui-monospace, monospace",
  fontSize: 13,
  textDecoration: "none",
};

export default function Home() {
  return (
    <main style={{ padding: 32, fontFamily: "system-ui, sans-serif", color: "#f5f5f5", maxWidth: 820 }}>
      <h1 style={{ marginTop: 0 }}>@fanos/renderer harness</h1>
      <p style={{ opacity: 0.75, fontSize: 14, lineHeight: 1.6 }}>
        Each frame renders from two trees built off the <em>same</em> Figma IR.{" "}
        <strong>hand-authored</strong> has bindings, Repeaters and named icons.{" "}
        <strong>@fanos/compile</strong> is fully deterministic and refuses to guess any of those —
        so its text is literal, its images have no source and its icons are placeholders. What
        differs is precisely what the IR cannot tell you.
      </p>

      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 14 }}>
        <thead>
          <tr style={{ textAlign: "left", opacity: 0.6, fontSize: 12 }}>
            <th style={{ padding: "8px 12px 8px 0" }}>frame</th>
            <th style={{ padding: 8 }}>hand-authored</th>
            <th style={{ padding: 8 }}>compiled</th>
            <th style={{ padding: 8 }}>+ repair</th>
            <th style={{ padding: 8 }}>notes</th>
          </tr>
        </thead>
        <tbody>
          {CARDS.map((c) => {
            const w = c.width ? `&width=${c.width}` : "";
            return (
              <tr key={c.key} style={{ borderTop: "1px solid #333" }}>
                <td style={{ padding: "10px 12px 10px 0" }}>
                  <div>{c.label}</div>
                  <div style={{ opacity: 0.5, fontSize: 12, fontFamily: "ui-monospace, monospace" }}>
                    {c.geom} · {c.ir}
                  </div>
                </td>
                <td style={{ padding: 8 }}>
                  {("hand" in c ? c.hand : true) ? (
                    <a style={link} href={`/render?card=${c.key}&from=hand${w}`}>
                      open
                    </a>
                  ) : (
                    <span style={{ opacity: 0.4, fontSize: 12 }} title="never hand-authored">
                      none
                    </span>
                  )}
                </td>
                <td style={{ padding: 8 }}>
                  <a style={link} href={`/render?card=${c.key}&from=compiled${w}`}>
                    open
                  </a>
                </td>
                <td style={{ padding: 8 }}>
                  {("repaired" in c ? c.repaired : false) ? (
                    <a style={link} href={`/render?card=${c.key}&from=repaired${w}`}>
                      open
                    </a>
                  ) : (
                    <span style={{ opacity: 0.3, fontSize: 12 }}>—</span>
                  )}
                </td>
                <td style={{ padding: 8, opacity: 0.6, fontSize: 12 }}>{c.note}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p style={{ opacity: 0.6, fontSize: 13, marginTop: 28, lineHeight: 1.6 }}>
        Compiled trees live in <code>packages/compile/out/</code>. Regenerate with{" "}
        <code>fos-compile build --ir … --theme … --surfaces …</code>, check fidelity with{" "}
        <code>fos-conform check --tree … --ir …</code>.
      </p>
    </main>
  );
}
