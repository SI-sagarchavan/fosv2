import { useRef, useState } from "react";
import type { Source } from "../api.js";
import { clearDropped, setDropped, useDropped } from "../playground.js";
import { Inspector, type Tab } from "./Inspector.js";

const TABS: Tab[] = ["gaps", "render", "ir", "dsl", "data"];

export function Playground({ tab, node }: { tab: string | undefined; node: string | null }) {
  const dropped = useDropped();

  if (!dropped) return <Drop />;

  const active: Tab = (TABS as string[]).includes(tab ?? "") ? (tab as Tab) : "gaps";
  const source: Source = { kind: "inline", ir: dropped.ir, key: dropped.key, name: dropped.name };

  return (
    <Inspector
      title={dropped.name}
      sub="Dropped into the Playground — compiled here, nothing stored."
      base="/playground"
      tabs={TABS}
      tab={active}
      node={node}
      source={source}
      aside={
        <button className="chip" onClick={clearDropped}>
          Use another file
        </button>
      }
    />
  );
}

function Drop() {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [paste, setPaste] = useState("");

  function accept(name: string, text: string): void {
    try {
      const ir: unknown = JSON.parse(text);
      const doc = ir as { root?: unknown; irVersion?: unknown } | null;
      if (!doc || typeof doc !== "object" || !doc.root || typeof doc.irVersion !== "string") {
        throw new Error("that is JSON, but not a Frame IR document — it needs `irVersion` and `root`");
      }
      setError(null);
      setDropped(name, ir);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function read(file: File | undefined): Promise<void> {
    if (file) accept(file.name, await file.text());
  }

  return (
    <section className="playground">
      <h2>Playground</h2>
      <p className="lede">
        Drop a Frame IR file — the <code>.json</code> from Surface Canvas, or the one inside its ZIP — to see what it
        compiles to, what the trip lost, and how data would bind to it. Nothing is stored and the control plane
        is not involved, so this works with only Studio running.
      </p>

      <div
        className={over ? "drop is-over" : "drop"}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void read(e.dataTransfer.files[0]);
        }}
      >
        <p>Drop an IR file here</p>
        <button className="go" onClick={() => input.current?.click()}>
          Choose a file
        </button>
        <input ref={input} type="file" accept=".json,application/json" hidden onChange={(e) => void read(e.target.files?.[0])} />
      </div>

      <details className="paste">
        <summary>Or paste the JSON</summary>
        <textarea className="code" value={paste} onChange={(e) => setPaste(e.target.value)} spellCheck={false} aria-label="IR JSON" />
        <button className="chip" disabled={!paste.trim()} onClick={() => accept("pasted IR", paste)}>
          Inspect
        </button>
      </details>

      {error ? <p className="compile-error">{error}</p> : null}
    </section>
  );
}
