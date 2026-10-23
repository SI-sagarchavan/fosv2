import { href } from "../router.js";

/**
 * How a Figma frame becomes a page, and where a data feed plugs in.
 *
 * Static on purpose, and each claim here was checked against the code it names —
 * this page is documentation, and documentation that drifts is worse than none.
 * The numbers for a real frame are on the Gaps tab of any export.
 */

interface Stage {
  n: number;
  name: string;
  code: string;
  reads: string;
  writes: string;
  drops: string[];
}

const STAGES: Stage[] = [
  {
    n: 1,
    name: "Figma → IR",
    code: "@fanos/surface-canvas · traverse.ts → ir/schema.ts",
    reads: "The selected frame's visible layers.",
    writes:
      "Frame IR 1.8: per layer the layout (mode, gap, padding, sizing, positioning), geometry (box, rotation), fill / stroke / radius / effects with a token ref or a raw value flagged `unbound`, text (characters, style, lines, truncation, case), image fit, component key, and structural signatures. Plus any background images the designer marked.",
    drops: [
      "Hidden layers — skipped during traversal.",
      "Vector path data. A glyph is identified by its layer name or not at all.",
      "One text style per layer — mixed runs inside a layer are not represented.",
      "The crop rectangle of a cropped image; it becomes `cover`.",
      "Small caps (the DSL cannot say it).",
    ],
  },
  {
    n: 2,
    name: "IR → DSL",
    code: "@fanos/compile · classify → emit → cleanup",
    reads: "The IR and the theme. Deterministic: same input, same tree, no model.",
    writes:
      "A flat tree of Box, Stack, Overlay, Text, Image, Icon, Divider and Button nodes with token refs. A plate that exactly fills its parent folds into a `surface` ref; a component named `atom_button` becomes a Button; a full-width band becomes fluid.",
    drops: [
      "Text whose type style resolves to no token — the node is not emitted, only a note is.",
      "Decorative vectors, redundant crops, and zero-valued props.",
      "Opacity on anything but a Divider. Rotation: used to size a box, never emitted — Text.orientation exists in the DSL and is never set.",
      "Effects, unless a `surface` carries them.",
      "Never produced: bindings, Repeaters, `when`, button destinations. An icon's identity is its layer name, or an alias someone declared.",
    ],
  },
  {
    n: 3,
    name: "Gate",
    code: "@fanos/conform · C1–C5 and @fanos/dsl · validate",
    reads: "The tree against the IR it came from, and against the registry.",
    writes:
      "C1 coverage (did anything that paints go missing), C2 geometry (needs rendered boxes), C3 sizing (px where the IR says hug or fill), C4 snapping, C5 `src` integrity; then S/T legality and token coverage. A deliberate departure is waived on the node with a reason.",
    drops: ["C2 only runs on a real run, where the page has been rendered and measured."],
  },
  {
    n: 4,
    name: "Bind",
    code: "@fanos/dsl · bind.ts, collapse.ts, ops.ts",
    reads: "A binding plan, keyed by Figma node id.",
    writes:
      "`{path}` into string props, and N identical sibling subtrees collapsed into one Repeater with an alias. Entries that no longer fit the tree are reported as drift, never thrown.",
    drops: [
      "A plan is authored by hand today — the Data & logic tab proposes one.",
      "Only runs of identical siblings collapse; index-tiered grids need one plan entry per index.",
    ],
  },
  {
    n: 5,
    name: "Render",
    code: "@fanos/renderer · Render.tsx",
    reads: "The tree, a theme, a data bag.",
    writes: "HTML. Dot-path interpolation (`{a.b}`), Repeater over / as / limit / slice. Unresolved paths stay literal.",
    drops: [
      "9 of the 18 node types render: Box, Stack, Overlay, Text, Button, Image, Icon, Divider, Repeater. The rest draw an empty, marked placeholder.",
      "`when`, `platform`, `reveal`, `paginate` and the Tabs / Countdown behaviours are not evaluated.",
    ],
  },
];

type Level = "works" | "partial" | "missing";

const CAPABILITIES: Array<{ what: string; level: Level; today: string }> = [
  { what: "Static text, images, buttons from a design", level: "works", today: "IR → DSL → render, end to end." },
  { what: "Bind a prop to a field", level: "works", today: "`{path}` in a string prop; unresolved stays literal, with a warning." },
  { what: "Repeat a card over a list", level: "works", today: "Repeater over / as, with limit or slice window." },
  { what: "Propose bindings from a sample response", level: "partial", today: "Studio does it for exact copy matches and aligned lists; nothing infers meaning." },
  { what: "Fetch from an API", level: "missing", today: "No source declaration. `?data=` takes a stored artifact or a file in apps/api/data." },
  { what: "Loading, empty and error states", level: "missing", today: "A Repeater over a missing list renders nothing and warns in the console." },
  { what: "Show / hide on a condition", level: "missing", today: "`when` is in the schema and ignored by the renderer; its contents are unvalidated." },
  { what: "Format a value (date, number, currency)", level: "missing", today: "Interpolation is substitution only — a date renders as the API sent it." },
  { what: "Per-item position (first, last, index)", level: "missing", today: "The item alias is all a template sees." },
  { what: "Pagination / load more", level: "missing", today: "`paginate` is schema only." },
  { what: "Button does something", level: "partial", today: "navigate and submit render; `open` and `custom` carry no handler." },
  { what: "An API field added after the design", level: "partial", today: "Studio lists unread fields; adding the element is manual." },
];

const MARK: Record<Level, string> = { works: "works", partial: "partly", missing: "not yet" };

export function Pipeline() {
  return (
    <div className="pipeline">
      <h2>The pipeline</h2>
      <p className="lede">
        Five stages, one tree. Everything before stage 4 is mechanical and deterministic; stage 4 is the only place a
        human decides what is data. Open any export's <b>Gaps</b> tab for the numbers on a real frame, or{" "}
        <a href={href("/playground")}>drop an IR file</a> to try one.
      </p>

      <ol className="stages">
        {STAGES.map((s) => (
          <li key={s.n} className="stage">
            <span className="stage-n">{s.n}</span>
            <div>
              <h3>{s.name}</h3>
              <p className="stage-code">{s.code}</p>
              <p>
                <b>Reads</b> {s.reads}
              </p>
              <p>
                <b>Writes</b> {s.writes}
              </p>
              <p className="stage-drops">
                <b>Loses or leaves out</b>
              </p>
              <ul>
                {s.drops.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </div>
          </li>
        ))}
      </ol>

      <h2>Connecting business logic and APIs</h2>
      <p className="lede">
        The DSL describes what a page looks like. Everything about where its data comes from and when parts of it
        appear is currently outside it. What exists, and what does not:
      </p>

      <table className="caps">
        <tbody>
          {CAPABILITIES.map((c) => (
            <tr key={c.what}>
              <td>
                <span className={`level is-${c.level}`}>{MARK[c.level]}</span>
              </td>
              <td>{c.what}</td>
              <td>{c.today}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Proposal: keep the tree presentational, put logic in a sidecar</h3>
      <p>
        Do not teach the tree to fetch. Add one artifact next to it — a <b>data contract</b> — and let the tree
        stay a pure function of (tree, data, theme). Three reasons: the tree is generated and regenerated from Figma,
        so anything hand-written inside it is lost on the next compile; the same tree has to render on web and native;
        and a pure tree is the only kind the fidelity harness can diff.
      </p>
      <pre className="json">{`{
  "sources": {
    "news": {
      "url": "{env.API}/v1/news",
      "query": { "limit": 12 },
      "select": "data.articles",          // where the list lives in the response
      "revalidate": 60,                    // seconds
      "onError": "stale"                   // stale | empty | fail
    }
  },
  "bindings": [ /* today's binding plan: { src, prop, path } */ ],
  "repeat":   [ /* today's collapse:     { over, as, slice, members, fields } */ ],
  "format":   { "article.date": "date:MMM d, y" },
  "states":   { "news": { "loading": "skeleton", "empty": "hide" } }
}`}</pre>
      <p>Runtime pieces that would have to exist, in the order they pay for themselves:</p>
      <ol className="plain">
        <li>
          <b>A fetch layer outside the renderer</b> — resolves <code>sources</code> to the data bag the renderer already
          takes. The web app owns it (it already owns routing and streaming); the renderer stays pure.
        </li>
        <li>
          <b>Evaluate <code>when</code></b> with a small closed grammar — <code>{`{ path, op: exists|eq|ne|gt|in, value }`}</code> — and
          no expression evaluation. It is already in the schema; this makes it real and gives “hide if empty” and
          “show LIVE tag when <code>match.status = live</code>”.
        </li>
        <li>
          <b>Repeater states</b> — <code>empty</code> and <code>loading</code> children, and <code>index</code> / <code>first</code> /{" "}
          <code>last</code> in the item scope. Without them a list that comes back empty leaves a hole in the page.
        </li>
        <li>
          <b>A closed formatter registry</b> — <code>{`{article.date | date:"MMM d"}`}</code> — so a date does not have to be
          pre-formatted by the API.
        </li>
        <li>
          <b>Adding a UI element for a new API field</b> — a tree op that clones a sibling node of the same kind into the
          Repeater template and binds it, driven from the “API fields nothing reads” list. The ops
          (<code>insertBefore</code>, <code>setProp</code>) already exist; it needs a UI and a rule for which sibling to clone.
        </li>
      </ol>
      <p className="note">
        Decision for you: whether the contract is a new artifact kind (<code>data_contract</code>) alongside the existing{" "}
        <code>binding_plan</code>, or the plan grows these fields. A new kind is cleaner to version; extending the plan
        is less to build.
      </p>
    </div>
  );
}
