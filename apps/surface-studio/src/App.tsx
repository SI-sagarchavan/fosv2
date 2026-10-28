import { useBoard } from "./board.js";
import { useRoute, href } from "./router.js";
import { Board } from "./pages/Board.js";
import { ExportPage } from "./pages/ExportPage.js";
import { Pipeline } from "./pages/Pipeline.js";
import { Playground } from "./pages/Playground.js";
import { Sections } from "./pages/Sections.js";

const NAV = [
  { to: "/sections", label: "Sections", match: (p: string[]) => p[0] === "sections" },
  { to: "/", label: "Board", match: (p: string[]) => p.length === 0 || p[0] === "export" },
  { to: "/playground", label: "Playground", match: (p: string[]) => p[0] === "playground" },
  { to: "/pipeline", label: "Pipeline", match: (p: string[]) => p[0] === "pipeline" },
];

export function App() {
  const route = useRoute();
  const { rows, error } = useBoard();
  const [section, id, tab] = route.path;

  const live = rows.filter((r) => r.status !== "dismissed").length;
  const node = route.query.get("node");

  return (
    <div className="app">
      <header className="head">
        <div>
          <p className="eyebrow">FanOS</p>
          <h1>Surface Studio</h1>
        </div>
        <nav className="nav" aria-label="Sections">
          {NAV.map((n) => (
            <a key={n.to} href={href(n.to)} className={n.match(route.path) ? "nav-link is-on" : "nav-link"}>
              {n.label}
            </a>
          ))}
        </nav>
        <p className={error ? "live is-bad" : live > 0 ? "live is-on" : "live"}>
          {error ? "board offline" : live > 0 ? `${live} on the board` : "listening :3000"}
        </p>
      </header>

      <main>
        {section === "export" && id ? (
          <ExportPage id={id} tab={tab} node={node} />
        ) : section === "sections" ? (
          <Sections name={id} />
        ) : section === "playground" ? (
          <Playground tab={id} node={node} />
        ) : section === "pipeline" ? (
          <Pipeline />
        ) : (
          <Board />
        )}
      </main>
    </div>
  );
}
